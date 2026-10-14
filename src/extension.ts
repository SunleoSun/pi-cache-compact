/**
 * pi-cache-compact — cache-friendly compaction for Pi.
 *
 * Pi's default compaction builds a brand-new request to write the summary: its
 * own system prompt, the transcript re-serialized into one user message, and
 * cache writes disabled. On a locally hosted model with prefix caching that can
 * never reuse the KV cache, so the whole conversation is re-prefilled just to
 * produce the summary — the expensive part you were trying to avoid.
 *
 * In preserve-dialogue mode the extension owns checkpoint timing completely:
 * at safe turn_end boundaries it checks whether the current context entered
 * reserveTokens, checkpoints only older raw technical state, keeps the current
 * assistant/tool batch raw, and disables/cancels Pi-native compaction paths.
 *
 * The summary itself is asked as a strict continuation of the live conversation
 * (same system prompt, same tools, same messages, one appended user turn), so a
 * prefix-caching server serves everything but the ask from cache. Normal mode
 * still only replaces Pi's summarization call.
 */

import { join, resolve } from "node:path"

import {
  CONFIG_DIR_NAME,
  DEFAULT_COMPACTION_SETTINGS,
  SettingsManager,
  convertToLlm,
  getAgentDir,
} from "@earendil-works/pi-coding-agent"
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { retryAssistantCall, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai"

import {
  activeToolDeclarations,
  buildSummaryContext,
  computeFileLists,
  computeFileListsFromMessages,
  formatFileOperations,
  extractLiveReasoningEffort,
  extractLiveToolChoice,
  extractSummaryText,
  isModelAllowed,
  messagesBeforeEntry,
  estimateMessagesTokens,
  planSummaryRequest,
  promptTokensOf,
  preserveReserveTokens,
  preserveSummaryOrdinalRejection,
  replayableHeaders,
  resolveSummaryReasoningEffort,
  resolveSummaryToolChoice,
  summaryRejection,
  summaryOutputCap,
  tokenScale,
  unreportedTokenScale,
  looksLikeToolCall,
  NO_TEXT_REPLY,
  PARSED_TOOL_CALL_REPLY,
  TOOL_CALL_TEXT_REPLY,
  type LiveEffort,
  type LiveToolChoice,
  type SummaryRequestPlan,
  type SummaryRequestShape,
} from "./build.ts"
import { readOptions, type CacheCompactOptions } from "./config.ts"
import {
  DebugLogger,
  compactPayloadForLog,
  fingerprintPayload,
  providerToolNames,
  redactHeaders,
  rollingMessageHashes,
  sharedPrefixLength,
  shortHash,
  snapshot,
} from "./debug.ts"
import {
  PRESERVE_DIALOGUE_CHECKPOINT_TYPE,
  PRESERVE_DIALOGUE_MARKER,
  isPreserveDialogueCompaction,
  isPreservedAssistantReply,
  latestPreserveDialogueState,
  preserveDeltaScope,
  preserveDeltaTailCandidates,
  preserveDialogueBoundaryEntries,
  preserveDialogueDeltaMessages,
  preserveDialogueStates,
  preservedCheckpointMessages,
  preservedContextMessages,
  preservedDialogueMessages,
  previewPreservedContextAfterCheckpoint,
  rebuildPreservedDialogue,
  type CacheCompactDetails,
} from "./preserve.ts"

export type { CacheCompactOptions } from "./config.ts"

function loggerFor(options: CacheCompactOptions): DebugLogger {
  return new DebugLogger(options.debug === true, options.debugFile)
}

/**
 * Compact description of an assistant reply's blocks, for the debug file. A
 * reply that "stopped" with no text block is the failure this exists to
 * explain: it means the answer never left the reasoning channel, so the counts
 * and sizes per block are the whole diagnosis.
 */
function describeContent(
  content: AssistantMessage["content"],
  preview = false,
): { type: string; chars: number; head?: string }[] {
  return content.map((block) => {
    if (block.type === "text") {
      return {
        type: "text",
        chars: block.text.length,
        ...(preview ? { head: head(block.text) } : undefined),
      }
    }
    if (block.type === "thinking") {
      const thinking = String(block.thinking ?? "")
      return {
        type: "thinking",
        chars: thinking.length,
        ...(preview ? { head: head(thinking) } : undefined),
      }
    }
    return { type: block.type, chars: 0 }
  })
}

/** First `limit` characters, for telling a finished summary from deliberations. */
function head(text: string, limit = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed
}

function effectiveAgentMessages(
  projectedAgent: readonly AgentMessage[],
  branchEntries: readonly SessionEntry[],
): AgentMessage[] {
  let systemCount = 0
  while (projectedAgent[systemCount]?.role === "system") systemCount += 1
  const rebuiltConversation = rebuildPreservedDialogue(
    projectedAgent.slice(systemCount),
    branchEntries,
  )
  return rebuiltConversation
    ? [...projectedAgent.slice(0, systemCount), ...rebuiltConversation]
    : [...projectedAgent]
}

type CompactionBranch = "reserve threshold" | "manual"

const PI_NATIVE_DISABLE_STATE = Symbol.for("pi-cache-compact.pi-native-disable.v2")

type PiNativeDisableRule = (model: Pick<Model<Api>, "provider" | "id"> | undefined) => boolean

type PiNativeDisableState = {
  original: SettingsManager["getCompactionSettings"]
  rules: Map<string, PiNativeDisableRule>
}

function normalizedSettingsPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function projectSettingsKey(cwd: string): string {
  return normalizedSettingsPath(join(cwd, CONFIG_DIR_NAME, "settings.json"))
}

/**
 * Preserve mode owns automatic compaction at turn boundaries. Disable Pi's
 * native compaction decision in memory for the eligible project/model so its
 * threshold/overflow path cannot race or replace our checkpoint policy.
 *
 * Pi exposes no per-session compaction setter, so patch only the in-memory
 * getter and scope the rule by project settings path. No settings file is
 * rewritten and unrelated sessions/modes keep Pi's original behavior.
 */
function installPiNativeCompactionDisable(): PiNativeDisableState {
  const prototype = SettingsManager.prototype as typeof SettingsManager.prototype &
    Record<PropertyKey, unknown>
  const existing = prototype[PI_NATIVE_DISABLE_STATE] as PiNativeDisableState | undefined
  if (existing) return existing

  const original = SettingsManager.prototype.getCompactionSettings
  const state: PiNativeDisableState = { original, rules: new Map() }
  Object.defineProperty(prototype, PI_NATIVE_DISABLE_STATE, {
    value: state,
    configurable: false,
    enumerable: false,
    writable: false,
  })

  SettingsManager.prototype.getCompactionSettings = function (model) {
    const base = original.call(this, model)
    const projectPath = (this as unknown as { settingsPaths?: { project?: string } }).settingsPaths
      ?.project
    if (!projectPath) return base
    const rule = state.rules.get(normalizedSettingsPath(projectPath))
    if (!rule) return base
    const disabled = rule(model as Pick<Model<Api>, "provider" | "id"> | undefined)
    // Automatic compaction stays disabled, but manual /compact still calls
    // prepareCompaction() before extensions see session_before_compact. Force the
    // smallest retained suffix so even a short session with technical state reaches
    // our preserve hook instead of being rejected by Pi's keepRecentTokens gate.
    return disabled ? { ...base, enabled: false, keepRecentTokens: 1 } : base
  }

  return state
}

function piCompactionSettings(ctx: ExtensionContext, model: Model<Api>) {
  try {
    return SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    }).getCompactionSettings(model)
  } catch {
    return DEFAULT_COMPACTION_SETTINGS
  }
}
function piRetrySettings(ctx: ExtensionContext) {
  try {
    return SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    }).getRetrySettings()
  } catch {
    return SettingsManager.inMemory().getRetrySettings()
  }
}
function notify(
  ctx: ExtensionContext,
  message: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (!ctx.hasUI) return
  try {
    ctx.ui.notify(message, type)
  } catch {
    // A UI notification must never affect compaction.
  }
}

type CompactionTokenBreakdown = {
  preserved: number
  preservedDialogue: number
  preservedUserMessages: number
  preservedAssistantText: number
  historicalCheckpoints: number
  checkpointCount: number
  newRawCompactable: number
  compactable: number
  rawToolCalls: number
  rawToolResults: number
  rawReasoning: number
  rawOther: number
  nonSystemTotal: number
  scale: number
  calibratedScale: number
}

function compactionMessageTokens(
  ctx: ExtensionContext,
  branchEntries: readonly SessionEntry[],
): CompactionTokenBreakdown {
  const projection = ctx.sessionManager.buildSessionProjection()
  const effectiveAgent = effectiveAgentMessages(
    projection.messages as AgentMessage[],
    branchEntries,
  )
  const liveMessages = convertToLlm(effectiveAgent)
  const calibratedScale = tokenScale(liveMessages)
  const scale = unreportedTokenScale(liveMessages)
  const nonSystemMessages = liveMessages.filter((message) => message.role !== "system")
  const estimate = (messages: readonly AgentMessage[]): number =>
    Math.ceil(estimateMessagesTokens(convertToLlm([...messages])) * scale)

  const dialogueMessages = preservedDialogueMessages(branchEntries)
  const checkpointMessages = preservedCheckpointMessages(branchEntries)
  const preservedUserMessages = estimate(
    dialogueMessages.filter((message) => message.role === "user"),
  )
  const preservedAssistantText = estimate(
    dialogueMessages.filter((message) => message.role === "assistant"),
  )
  const preservedDialogue = estimate(dialogueMessages)
  const historicalCheckpoints = estimate(checkpointMessages)
  const preserved = preservedDialogue + historicalCheckpoints
  const nonSystemTotal = Math.ceil(estimateMessagesTokens(nonSystemMessages) * scale)
  const newRawCompactable = Math.max(0, nonSystemTotal - preserved)

  const toolResults = effectiveAgent.filter((message) => message.role === "toolResult")
  const assistantSubset = (type: "toolCall" | "thinking"): AgentMessage[] =>
    effectiveAgent.flatMap((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) return []
      const content = message.content.filter((block) => block.type === type)
      return content.length > 0 ? [{ ...message, content } as AgentMessage] : []
    })
  const rawToolResults = Math.min(newRawCompactable, estimate(toolResults))
  const rawToolCalls = Math.min(newRawCompactable, estimate(assistantSubset("toolCall")))
  const rawReasoning = Math.min(newRawCompactable, estimate(assistantSubset("thinking")))
  const classified = Math.min(newRawCompactable, rawToolResults + rawToolCalls + rawReasoning)

  return {
    preserved,
    preservedDialogue,
    preservedUserMessages,
    preservedAssistantText,
    historicalCheckpoints,
    checkpointCount: preserveDialogueStates(branchEntries).length,
    newRawCompactable,
    compactable: newRawCompactable,
    rawToolCalls,
    rawToolResults,
    rawReasoning,
    rawOther: Math.max(0, newRawCompactable - classified),
    nonSystemTotal,
    scale,
    calibratedScale,
  }
}

function debugMessageKind(message: unknown): string {
  const record = message && typeof message === "object" ? (message as Record<string, unknown>) : {}
  const role = typeof record.role === "string" ? record.role : "unknown"
  if (role !== "assistant") return role
  const content = Array.isArray(record.content) ? record.content : []
  const types = content
    .map((block) =>
      block && typeof block === "object"
        ? String((block as Record<string, unknown>).type ?? "")
        : "",
    )
    .filter(Boolean)
  if (types.includes("toolCall"))
    return types.includes("text") ? "assistant-visible+tool-call" : "assistant-tool-call"
  if (types.includes("thinking"))
    return types.includes("text") ? "assistant-visible+reasoning" : "assistant-reasoning"
  return "assistant-visible"
}

function debugContextIndex(
  messages: readonly unknown[],
  scale: number,
  branchEntries: readonly SessionEntry[] = [],
  syntheticCheckpoint?: { number: number; summary: string },
): Array<Record<string, unknown>> {
  const usedEntryIds = new Set<string>()
  const checkpointCandidates = preserveDialogueStates(branchEntries).map((state, index) => ({
    number: state.details?.checkpoint?.number ?? index + 1,
    summary: state.summary,
    sourceEntryId:
      "id" in state.entry && typeof state.entry.id === "string" ? state.entry.id : null,
  }))
  if (syntheticCheckpoint) {
    checkpointCandidates.push({
      number: syntheticCheckpoint.number,
      summary: syntheticCheckpoint.summary,
      sourceEntryId: null,
    })
  }

  const ignoredAnchors = new Set([
    "user",
    "assistant",
    "toolResult",
    "custom",
    "text",
    "thinking",
    "toolCall",
  ])
  const stringAnchors = (value: unknown, out: string[] = []): string[] => {
    if (typeof value === "string") {
      const trimmed = value.trim()
      if (trimmed.length >= 3 && !ignoredAnchors.has(trimmed)) out.push(trimmed)
      return out
    }
    if (Array.isArray(value)) {
      for (const item of value) stringAnchors(item, out)
      return out
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) stringAnchors(item, out)
    }
    return out
  }
  const providerRole = (message: unknown): string =>
    String((message as { role?: unknown } | undefined)?.role ?? "")
  const compatibleRole = (wireRole: string, entryRole: string): boolean => {
    if (wireRole === "assistant") return entryRole === "assistant"
    if (wireRole === "tool" || wireRole === "toolResult") return entryRole === "toolResult"
    if (wireRole === "user") return entryRole === "user" || entryRole === "custom"
    if (wireRole === "system" || wireRole === "developer") return false
    return wireRole === entryRole
  }

  return messages.map((message, index) => {
    const record =
      message && typeof message === "object" ? (message as Record<string, unknown>) : {}
    const estimatedTokens = Math.ceil(
      estimateMessagesTokens([message] as unknown as Parameters<typeof estimateMessagesTokens>[0]) *
        scale,
    )
    const serialized = JSON.stringify(message)
    const checkpoint = checkpointCandidates.find((candidate) => {
      if (candidate.summary.length === 0) return false
      const escapedSummary = JSON.stringify(candidate.summary).slice(1, -1)
      return serialized.includes(escapedSummary)
    })
    let sourceEntryId: string | null = checkpoint?.sourceEntryId ?? null
    let checkpointNumber: number | null = checkpoint?.number ?? null

    if (!checkpoint) {
      const wireRole = providerRole(message)
      let bestEntry: Extract<SessionEntry, { type: "message" }> | undefined
      let bestScore = -1
      for (const entry of branchEntries) {
        if (entry.type !== "message" || usedEntryIds.has(entry.id)) continue
        if (!compatibleRole(wireRole, entry.message.role)) continue
        const matchedAnchors = stringAnchors(entry.message).filter((anchor) =>
          serialized.includes(anchor),
        )
        if (matchedAnchors.length === 0) continue
        const score =
          matchedAnchors.length * 1000 +
          matchedAnchors.reduce((sum, anchor) => sum + anchor.length, 0)
        if (score <= bestScore) continue
        bestScore = score
        bestEntry = entry
      }
      if (bestEntry) {
        sourceEntryId = bestEntry.id
        usedEntryIds.add(bestEntry.id)
      }
    }

    return {
      index,
      role: typeof record.role === "string" ? record.role : "unknown",
      kind: debugMessageKind(message),
      sourceEntryId,
      checkpointNumber,
      estimatedTokens,
      hash: shortHash(message),
    }
  })
}
/** Summarize with `summaryModel` when configured and resolvable, else the active model. */
function resolveSummarizer(
  ctx: ExtensionContext,
  options: CacheCompactOptions,
  fallback: Model<Api>,
): Model<Api> {
  const wanted = options.summaryModel
  if (!wanted) return fallback
  return ctx.modelRegistry.find(wanted.provider, wanted.id) ?? fallback
}

/** Build and run the cache-friendly summarization request. */
async function generateSummary(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: SessionBeforeCompactEvent,
  options: CacheCompactOptions,
  summarizer: Model<Api>,
  reasoningEffort: string | undefined,
  toolChoice: "auto" | "none" | undefined,
  plan: SummaryRequestPlan,
  onPayload?: (
    payload: unknown,
    info: {
      hasLeadingSystemMessage: boolean
      droppedCount: number
      sentCount: number
      requestShape: SummaryRequestShape
    },
  ) => void,
  requestHeaders?: Record<string, string | null>,
): Promise<AssistantMessage> {
  const messages = plan.messages
  const ask = plan.ask
  // The projection usually starts with the recorded system message (prompt and
  // tool declarations). Recreating it would declare the prompt twice and break
  // the prefix; only synthesize one when the transcript has none.
  // Which branch runs is logged: the two must produce byte-identical requests
  // against the live prefix, and only the synthesized branch is covered by
  // e2e tests — a recorded-system divergence would miss the cache entirely.
  const hasLeadingSystemMessage = messages[0]?.role === "system"
  const context = buildSummaryContext({
    systemPrompt: hasLeadingSystemMessage ? undefined : ctx.getSystemPrompt(),
    tools: hasLeadingSystemMessage
      ? undefined
      : activeToolDeclarations(pi.getAllTools(), pi.getActiveTools()),
    messages,
    ask,
  })
  const retry = piRetrySettings(ctx)
  const sessionId = ctx.sessionManager.getSessionId()
  return await retryAssistantCall(
    () =>
      ctx.modelRegistry.complete(summarizer, context, {
        maxTokens: plan.maxTokens,
        signal: event.signal,
        cacheRetention: options.cacheRetention ?? "short",
        ...(toolChoice !== undefined ? { toolChoice } : undefined),
        // Mirror the effort the live prefix was actually sent with (see
        // extractLiveReasoningEffort): on servers that render the effort into the
        // prompt, any mismatch — including plain omission — misses the whole
        // prefix cache. Undefined reproduces the live omission.
        ...(reasoningEffort !== undefined ? { reasoningEffort } : undefined),
        // Replay the headers live requests send (session affinity, routing keys,
        // attribution) so the summarization ask is indistinguishable from a live
        // turn at the transport layer too.
        ...(requestHeaders !== undefined ? { headers: requestHeaders } : undefined),
        sessionId,
        // Our own complete() call bypasses the extension runner, so
        // before_provider_request never sees it. pi-ai invokes onPayload with the
        // exact request params at the same point the hook fires for live requests.
        onPayload: onPayload
          ? (payload: unknown) => {
              onPayload(payload, {
                hasLeadingSystemMessage,
                droppedCount: plan.droppedMessages.length,
                sentCount: plan.messages.length,
                requestShape: plan.shape,
              })
            }
          : undefined,
        onResponse: (response: { status: number; headers: Record<string, string> }) => {
          try {
            loggerFor(options).record("provider_response", {
              sessionId,
              summary: true,
              status: response.status,
              headers: redactHeaders(response.headers),
            })
          } catch {
            /* logging must never break the request path */
          }
        },
      }),
    retry,
    event.signal,
    {
      onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
      loggerFor(options).record("summary_provider_retry_scheduled", {
      sessionId,
      attempt,
      maxAttempts,
      delayMs,
      errorMessage,
      })
      const delayText =
      delayMs >= 1000
      ? `${Number.isInteger(delayMs / 1000) ? delayMs / 1000 : (delayMs / 1000).toFixed(1)}s`
      : `${delayMs}ms`
      notify(
      ctx,
      `[cache-compact] summary provider retry ${attempt}/${maxAttempts} in ${delayText}`,
      "warning",
      )
      },
      onRetryAttemptStart: () => {
        loggerFor(options).record("summary_provider_retry_attempt_start", { sessionId })
      },
      onRetryFinished: (success, attempt, finalError) => {
        loggerFor(options).record("summary_provider_retry_finished", {
          sessionId,
          success,
          attempt,
          ...(finalError ? { finalError } : undefined),
        })
      },
    },
  )
}

export default function cacheCompact(pi: ExtensionAPI): void {
  // Options are per working directory and read lazily, so a session started
  // after a config edit picks up the new file without a reload.
  const configs = new Map<string, CacheCompactOptions>()
  const piNativeDisable = installPiNativeCompactionDisable()
  const preserveReserves = new Map<
    string,
    {
      modelKey: string
      contextWindow: number
      reserveTokens: number
    }
  >()

  const optionsFor = (ctx: ExtensionContext): CacheCompactOptions => {
    const cached = configs.get(ctx.cwd)
    if (cached) return cached
    const paths = [
      join(getAgentDir(), "cache-compact.json"),
      join(ctx.cwd, CONFIG_DIR_NAME, "cache-compact.json"),
    ]
    let options: CacheCompactOptions = { preserveDialogue: true }
    try {
      options = readOptions(paths)
    } catch (error) {
      process.stderr.write(`[cache-compact] ignoring config: ${String(error)}\n`)
    }
    configs.set(ctx.cwd, options)
    return options
  }

  const syncPiNativeCompactionDisable = (
    ctx: ExtensionContext,
    options: CacheCompactOptions = optionsFor(ctx),
  ): void => {
    const key = projectSettingsKey(ctx.cwd)
    if (options.enabled === false || options.preserveDialogue !== true) {
      piNativeDisable.rules.delete(key)
      return
    }
    piNativeDisable.rules.set(key, (model) => {
      return Boolean(model && isModelAllowed(options.models, model.provider, model.id))
    })
  }

  const refreshPreserveReserve = (
    ctx: ExtensionContext,
    model: Model<Api> | undefined,
    source: "session_start" | "model_select" | "input" | "fallback",
  ): number | undefined => {
    const sessionId = ctx.sessionManager.getSessionId()
    const options = optionsFor(ctx)
    if (
      options.enabled === false ||
      options.preserveDialogue !== true ||
      !model ||
      !isModelAllowed(options.models, model.provider, model.id) ||
      !Number.isFinite(model.contextWindow) ||
      model.contextWindow <= 0
    ) {
      preserveReserves.delete(sessionId)
      return undefined
    }
    const contextWindow = Math.floor(model.contextWindow)
    const reserveTokens = preserveReserveTokens(contextWindow)
    preserveReserves.set(sessionId, {
      modelKey: model.provider + "/" + model.id,
      contextWindow,
      reserveTokens,
    })
    loggerFor(options).record("reserve_refresh", {
      sessionId,
      source,
      model: model.provider + "/" + model.id,
      contextWindow,
      reserveTokens,
    })
    return reserveTokens
  }

  const reserveFor = (ctx: ExtensionContext, model: Model<Api>): number => {
    const sessionId = ctx.sessionManager.getSessionId()
    const state = preserveReserves.get(sessionId)
    const modelKey = model.provider + "/" + model.id
    if (
      state &&
      state.modelKey === modelKey &&
      state.contextWindow === Math.floor(model.contextWindow)
    ) {
      return state.reserveTokens
    }
    return (
      refreshPreserveReserve(ctx, model, "fallback") ?? preserveReserveTokens(model.contextWindow)
    )
  }

  pi.on("session_start", (_event, ctx) => {
    configs.delete(ctx.cwd)
    const options = optionsFor(ctx)
    syncPiNativeCompactionDisable(ctx, options)
    refreshPreserveReserve(ctx, ctx.model, "session_start")
  })

  pi.on("model_select", (event, ctx) => {
    syncPiNativeCompactionDisable(ctx, optionsFor(ctx))
    refreshPreserveReserve(ctx, event.model, "model_select")
  })

  pi.on("input", (_event, ctx) => {
    syncPiNativeCompactionDisable(ctx, optionsFor(ctx))
    refreshPreserveReserve(ctx, ctx.model, "input")
  })

  pi.on("session_shutdown", (_event, ctx) => {
    piNativeDisable.rules.delete(projectSettingsKey(ctx.cwd))
    preserveReserves.delete(ctx.sessionManager.getSessionId())
    configs.delete(ctx.cwd)
  })

  // Ask-text hashes of summarization requests currently in flight. A
  // payload whose last user message hashes to one of these is one of ours;
  // belt and braces alongside the direct onPayload tagging below, in case a
  // future pi routes extension calls through the runner after all.
  const pendingAskHashes = new Set<string>()

  // Last live payloads, JSON-snapshotted, kept for `debugPayloads` dumps.
  // Snapshotted at capture (not at write) because the request object may be
  // mutated after the hook fires; capped at two so a long debug session does
  // not pin megabytes. Written out only when a compaction actually happens.
  const recentLivePayloads: { sessionId: string; payload: unknown }[] = []
  // Sessions whose next live request should be dumped as `live_after`.
  const dumpNextLive = new Set<string>()
  const pendingPostCompactionContext = new Map<
    string,
    { checkpointNumber: number; beforePayload?: unknown }
  >()

  // Last live request headers, per session, as captured by
  // `before_provider_headers`. The summary ask replays them (see
  // replayableHeaders) and both sides are logged redacted, so the debug file
  // can finally diff what the payload dump never shows: the headers live
  // requests carry and ours does not. Captured regardless of debug settings
  // — replay must work with logging off.
  const liveHeaders = new Map<string, Record<string, string | null>>()

  // Last reasoning effort observed on the wire, per session; `null` = the
  // live request sent none (also a distinct cache variant). The summary ask
  // mirrors this so its prefix matches what the server cached. Captured on
  // every request, independent of debug settings.
  const liveEfforts = new Map<string, LiveEffort>()
  const liveToolChoices = new Map<string, LiveToolChoice>()

  // How many messages the last live provider request carried, per session.
  // Messages appended since (the reply, tool results) are *not* in the
  // checkpoint the server holds, and a big tool result can be most of the
  // context — so this is what lets the ask continue the request itself instead
  // of the (possibly oversized) whole conversation. A count, never content.
  const liveRequestCounts = new Map<string, number>()

  // Provider cache usage is observational only and never changes compaction behavior.

  // Preserve-aware boundary checkpoints are asynchronous. Keep one in flight
  // per session so no overlapping boundary work can race the same branch.
  const dynamicCompactions = new Map<string, CompactionBranch>()

  type PendingCompactionUi = {
  branch: CompactionBranch
  tokens: CompactionTokenBreakdown
  scope: ReturnType<typeof preserveDeltaScope>
  compactedRawTokens: number
  compactedRawCalibratedTokens?: number
  remainingRawTokens: number
  tailEstimatedTokens: number
  unreportedScale: number
  reportedPrefixTokens?: number
  contextTokens?: number
  contextWindow?: number
  }
  const pendingCompactionUi = new Map<string, PendingCompactionUi>()
  const compactionFailureReasons = new Map<string, string>()

  const reportCompactionComplete = (
    ctx: ExtensionContext,
    fallbackBranch: CompactionBranch,
    summary: string,
    tokensBefore: number,
  ): void => {
    const sessionId = ctx.sessionManager.getSessionId()
    const pending = pendingCompactionUi.get(sessionId)
    pendingCompactionUi.delete(sessionId)
    compactionFailureReasons.delete(sessionId)
    const branch = pending?.branch ?? fallbackBranch

    let metrics = ""
    if (pending) {
      const checkpointMessage = {
        role: "custom",
        customType: PRESERVE_DIALOGUE_CHECKPOINT_TYPE,
        content: `## Tool Context Checkpoint #${pending.scope.nextCheckpointNumber}\n\n${summary}`,
        display: false,
        timestamp: Date.now(),
      } as AgentMessage
      const checkpointBaseTokens = estimateMessagesTokens(convertToLlm([checkpointMessage]))
      const checkpointSize = Math.ceil(checkpointBaseTokens * pending.unreportedScale)
      const checkpointCalibratedSize = Math.ceil(
        checkpointBaseTokens * pending.tokens.calibratedScale,
      )
      const calibrationRatio = pending.tokens.calibratedScale / pending.tokens.scale
      const calibrate = (tokens: number): number => Math.ceil(tokens * calibrationRatio)
      const compactedRawCalibrated =
        pending.compactedRawCalibratedTokens ?? calibrate(pending.compactedRawTokens)
      const remainingRawCalibrated = calibrate(pending.remainingRawTokens)
      const tailEstimatedCalibrated = calibrate(pending.tailEstimatedTokens)

      const projectionMessages = ctx.sessionManager.buildSessionProjection()
        .messages as AgentMessage[]
      const providerMessages = convertToLlm(projectionMessages)
      const systemPromptBaseTokens = estimateMessagesTokens(
        providerMessages.filter((message) => message.role === "system"),
      )
      const systemPromptTokens = Math.ceil(
        systemPromptBaseTokens * pending.tokens.calibratedScale,
      )
      const lastLive = [...recentLivePayloads]
        .reverse()
        .find((entry) => entry.sessionId === sessionId)
      const lastLivePayload = (lastLive?.payload ?? {}) as { tools?: unknown }
      const toolDeclarations = Array.isArray(lastLivePayload.tools)
        ? lastLivePayload.tools
        : activeToolDeclarations(pi.getAllTools(), pi.getActiveTools())
      const toolDeclarationTokens = Math.ceil(
        estimateMessagesTokens(toolDeclarations) * pending.tokens.calibratedScale,
      )
      const otherProviderOverhead = calibrate(
        Math.max(
          0,
          tokensBefore -
            pending.tokens.nonSystemTotal -
            Math.ceil(systemPromptBaseTokens * pending.tokens.scale) -
            Math.ceil(estimateMessagesTokens(toolDeclarations) * pending.tokens.scale),
        ),
      )
      const structuralAfter =
        calibrate(pending.tokens.preserved) +
        checkpointCalibratedSize +
        remainingRawCalibrated +
        systemPromptTokens +
        toolDeclarationTokens +
        otherProviderOverhead
      const anchoredAfter =
        pending.reportedPrefixTokens === undefined
          ? undefined
          : Math.max(0, pending.reportedPrefixTokens - compactedRawCalibrated) +
            checkpointCalibratedSize +
            tailEstimatedCalibrated
      const calibratedAfter =
        anchoredAfter === undefined ? structuralAfter : Math.max(structuralAfter, anchoredAfter)
      const compression =
        checkpointCalibratedSize > 0
          ? (compactedRawCalibrated / checkpointCalibratedSize).toFixed(1)
          : "∞"
      const covered =
        pending.scope.coveredUserMessages.length > 0
          ? pending.scope.coveredUserMessages.join(", ")
          : "(none)"
      metrics = [
        `context before (Pi usage): ${tokensBefore} tok`,
        `context after: ~${calibratedAfter} tok (provider-calibrated estimate)`,
        `compacted raw: ~${compactedRawCalibrated} tok`,
        "",
        `preserved dialogue: ~${calibrate(pending.tokens.preservedDialogue)} tok`,
        ` user messages: ~${calibrate(pending.tokens.preservedUserMessages)} tok`,
        ` assistant text: ~${calibrate(pending.tokens.preservedAssistantText)} tok`,
        `historical checkpoints: ~${calibrate(pending.tokens.historicalCheckpoints)} tok (${pending.tokens.checkpointCount})`,
        `raw technical before: ~${calibrate(pending.tokens.newRawCompactable)} tok`,
        ` older raw compacted: ~${compactedRawCalibrated} tok`,
        ` newest raw kept: ~${remainingRawCalibrated} tok`,
        ` tool calls: ~${calibrate(pending.tokens.rawToolCalls)} tok`,
        ` tool results: ~${calibrate(pending.tokens.rawToolResults)} tok`,
        ` reasoning: ~${calibrate(pending.tokens.rawReasoning)} tok`,
        ` other: ~${calibrate(pending.tokens.rawOther)} tok`,
        `new checkpoint #${pending.scope.nextCheckpointNumber}: ~${checkpointCalibratedSize} tok`,
        `system prompt: ~${systemPromptTokens} tok`,
        `tool declarations: ~${toolDeclarationTokens} tok`,
        `other provider overhead: ~${otherProviderOverhead} tok`,
        `checkpoint user messages: ${covered}`,
        `compression: ${compression}x`,
        "",
      ].join("\n")
    }

    notify(
      ctx,
      `[cache-compact] compact complete: ${branch}\n${metrics}tools/results summary:\n${summary.trim() || "(empty)"}`,
      "info",
    )
  }

  const reportCompactionFailure = (
    ctx: ExtensionContext,
    fallbackBranch: CompactionBranch,
    aborted: boolean,
    errorMessage?: string,
  ): void => {
    const sessionId = ctx.sessionManager.getSessionId()
    const pending = pendingCompactionUi.get(sessionId)
    pendingCompactionUi.delete(sessionId)
    const branch = pending?.branch ?? fallbackBranch
    const detail = compactionFailureReasons.get(sessionId) ?? errorMessage
    compactionFailureReasons.delete(sessionId)
    notify(
      ctx,
      `[cache-compact] compact ${aborted ? "cancelled" : "failed"}: ${branch}${detail ? `\n${detail}` : ""}`,
      aborted ? "warning" : "error",
    )
  }

  // A preserve-dialogue compaction hides old entries from Pi's normal
  // projection, but the raw branch is append-only. Rebuild the model view on
  // every live request so user prompts and completed assistant responses remain
  // verbatim while tool history stays compacted and old reasoning stays discarded.
  pi.on("context", (event, ctx) => {
    const options = optionsFor(ctx)
    syncPiNativeCompactionDisable(ctx, options)
    const model = ctx.model
    if (
      options.enabled === false ||
      options.preserveDialogue !== true ||
      !model ||
      !isModelAllowed(options.models, model.provider, model.id)
    )
      return undefined
    try {
      const messages = rebuildPreservedDialogue(event.messages, ctx.sessionManager.getBranch())
      return messages ? { messages } : undefined
    } catch (error) {
      // Context restoration must never break a request. Without a usable
      // marker/boundary Pi's native compacted projection remains valid, but make
      // the failure diagnosable because falling back here breaks preserve semantics.
      loggerFor(options).record("context_rebuild_failed", {
        sessionId: ctx.sessionManager.getSessionId(),
        error: String(error),
      })
      return undefined
    }
  })

  // Preserve mode owns automatic compaction completely. At turn_end the current
  // assistant batch is persisted but the next provider request has not started.
  // Crossing into reserveTokens checkpoints only older raw technical state; the
  // current batch stays verbatim after the new checkpoint and becomes eligible
  // at the following turn boundary, even when that later turn has no tool results.
  pi.on("turn_end", async (event, ctx) => {
    const options = optionsFor(ctx)
    syncPiNativeCompactionDisable(ctx, options)
    const model = ctx.model
    if (
      options.enabled === false ||
      options.preserveDialogue !== true ||
      !model ||
      !isModelAllowed(options.models, model.provider, model.id) ||
      event.entries.some((entry) => entry.type === "compaction")
    ) {
      return
    }

    const usage = ctx.getContextUsage()
    if (!usage || usage.tokens === null || usage.contextWindow <= 0) return

    const sessionId = ctx.sessionManager.getSessionId()
    if (dynamicCompactions.has(sessionId)) return

    const log = loggerFor(options)
    const triggerBranch: CompactionBranch = "reserve threshold"
    try {
      const branchEntries = ctx.sessionManager.getBranch() as SessionEntry[]
      const contextWindow =
        Number.isFinite(model.contextWindow) && model.contextWindow > 0
          ? Math.floor(model.contextWindow)
          : usage.contextWindow
      const reserveTokens = reserveFor(ctx, model)
      const thresholdTokens = Math.max(0, contextWindow - reserveTokens)
      const projection = ctx.sessionManager.buildSessionProjection()
      const effectiveAgent = effectiveAgentMessages(
        projection.messages as AgentMessage[],
        branchEntries,
      )
      const liveMessages = convertToLlm(effectiveAgent)
      const triggeringBatchAgentMessages = [event.message, ...event.toolResults] as AgentMessage[]
      const triggeringBatchMessages = convertToLlm(triggeringBatchAgentMessages)
      const scale = tokenScale(liveMessages)
      const unreportedScale = unreportedTokenScale(liveMessages)
      const triggeringBatchEstimatedTokens = Math.ceil(
      estimateMessagesTokens(triggeringBatchMessages) * unreportedScale,
      )
      const triggeringRawTailAgentMessages = triggeringBatchAgentMessages.filter(
      (message) =>
      message.role === "toolResult" ||
      (message.role === "assistant" && !isPreservedAssistantReply(message)),
      )
      const triggeringBatchRawEstimatedTokens = Math.ceil(
      estimateMessagesTokens(convertToLlm(triggeringRawTailAgentMessages)) * unreportedScale,
      )
      const providerMessage = event.message as AssistantMessage
      const reportedPrefixTokens = promptTokensOf(providerMessage)
      const providerUsage = providerMessage.usage
      const currentContextTokens = usage.tokens
      const scope = preserveDeltaScope(branchEntries, event.messageEntryId)

      log.record("dynamic_compaction_pressure", {
        sessionId,
        boundary: "turn_end",
        contextTokens: currentContextTokens,
        reportedContextTokens: usage.tokens,
        reportedPrefixTokens: reportedPrefixTokens ?? null,
                providerInputTokens: providerUsage?.input ?? null,
        providerOutputTokens: providerUsage?.output ?? null,
        providerReasoningTokens: providerUsage?.reasoning ?? null,
        providerStopReason: providerMessage.stopReason ?? null,
        providerCacheReadTokens: providerUsage?.cacheRead ?? null,
        providerCacheWriteTokens: providerUsage?.cacheWrite ?? null,
        contextWindow,
        reserveTokens,
        thresholdTokens,
        triggeringBatchEstimatedTokens,
        triggeringBatchRawEstimatedTokens,
        estimateScale: scale,
        unreportedScale,
        olderRawEntryCount: scope.rawEntryCount,
        trigger: currentContextTokens >= thresholdTokens,
      })
      if (currentContextTokens < thresholdTokens) return

      // The current batch is deliberately raw. If there is no older technical state
      // yet, there is nothing this checkpoint can reclaim without violating that
      // invariant. Stop a queued continuation only if that raw tail already fills the
      // physical window; a settled tool-free turn needs no special action.
      if (scope.rawEntryCount === 0) {
      log.record("reserve_threshold_no_older_raw_state", {
      sessionId,
      contextTokens: usage.tokens,
      contextWindow: usage.contextWindow,
      triggeringBatchEstimatedTokens,
      })
      if (event.continue && currentContextTokens >= contextWindow) {
      notify(
      ctx,
      "[cache-compact] latest raw tail fills the model window and no older technical state is available to compact",
      "warning",
      )
      return { entries: event.entries, continue: false }
      }
      return
      }

      dynamicCompactions.set(sessionId, triggerBranch)
      log.both("reserve threshold reached at turn boundary", {
        sessionId,
        contextTokens: usage.tokens,
        contextWindow: usage.contextWindow,
        reserveTokens,
        thresholdTokens,
        triggeringBatchEstimatedTokens,
        triggeringBatchRawEstimatedTokens,
        olderRawEntryCount: scope.rawEntryCount,
      })

      const syntheticEvent = {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: event.messageEntryId,
          tokensBefore: usage.tokens,
          messagesToSummarize: [],
          turnPrefixMessages: [],
          fileOps: {
            read: new Set<string>(),
            written: new Set<string>(),
            edited: new Set<string>(),
          },
          settings: {
            ...piCompactionSettings(ctx, model),
            enabled: false,
            reserveTokens,
          },
        },
        branchEntries,
        customInstructions: undefined,
        reason: "manual",
        willRetry: false,
        signal: ctx.signal ?? new AbortController().signal,
        preserveTailStartEntryId: event.messageEntryId,
        preserveTailMessageCount: triggeringBatchMessages.length,
        preserveTailEstimatedTokens: triggeringBatchEstimatedTokens,
        preserveTailRawEstimatedTokens: triggeringBatchRawEstimatedTokens,
        preserveTailAgentMessages: triggeringBatchAgentMessages,
        preservePrefixTokens: reportedPrefixTokens,
        // Delta-only selection is handled by the summary planner.
        } as unknown as SessionBeforeCompactEvent

      const result = await handleCompaction(syntheticEvent, ctx)
      if (!result?.compaction) {
        reportCompactionFailure(ctx, triggerBranch, true)
        log.record("dynamic_compaction_complete", { sessionId, cancelled: true })
        return
      }

      reportCompactionComplete(ctx, triggerBranch, result.compaction.summary, usage.tokens)
      log.record("dynamic_compaction_complete", { sessionId, cancelled: false })

      const resultDetails = result.compaction.details as CacheCompactDetails
      const rawTailStartEntryId =
      resultDetails.checkpoint?.rawTailStartEntryId ?? event.messageEntryId
      const checkpointEntries = preserveDialogueBoundaryEntries({
      branchEntries,
      summary: result.compaction.summary,
      tokensBefore: usage.tokens,
      details: resultDetails,
      rawTailStartEntryId,
      })
      return { entries: [...event.entries, ...checkpointEntries] }
    } catch (error) {
      reportCompactionFailure(ctx, triggerBranch, false, String(error))
      log.record("dynamic_compaction_check_failed", {
        sessionId,
        error: String(error),
      })
      return
    } finally {
      dynamicCompactions.delete(sessionId)
    }
  })

  // Preserve mode cancels Pi-native automatic threshold/overflow compaction.
  // A real manual /compact event is routed through the preserve checkpoint path;
  // its extension-provided result is persisted by Pi as an immutable preserve checkpoint.
  // Fingerprint every outgoing provider request — live turns and our own
  // summarization call alike. This is what makes cache divergence debuggable
  // after the fact: diff the `rolling` arrays of two records in the debug
  // file and the first differing index is the first message whose bytes
  // differ, i.e. where the prefix cache misses.
  pi.on("before_provider_request", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId()
    try {
      const observed = extractLiveReasoningEffort(event.payload)
      if (observed !== undefined) liveEfforts.set(sessionId, observed)
    } catch {
      /* observation must never break the request path */
    }
    try {
      const observed = extractLiveToolChoice(event.payload)
      if (observed !== undefined) liveToolChoices.set(sessionId, observed)
      else liveToolChoices.delete(sessionId)
    } catch {
      /* observation must never break the request path */
    }
    try {
      const messages = (event.payload as { messages?: unknown } | undefined)?.messages
      if (Array.isArray(messages)) liveRequestCounts.set(sessionId, messages.length)
    } catch {
      /* observation must never break the request path */
    }
    try {
      const options = optionsFor(ctx)
      if (options.debug !== true || !options.debugFile) return undefined
      const fingerprint = fingerprintPayload(event.payload)
      const askHash = fingerprint.lastMessageTextHash
      fingerprint.summary =
        typeof askHash === "string" && pendingAskHashes.has(askHash) ? true : undefined
      fingerprint.pendingSummary = pendingAskHashes.size > 0
      loggerFor(options).record("provider_request", {
        sessionId,
        activeModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        ...fingerprint,
      })
      if (fingerprint.summary !== true) {
        const payload = snapshot(event.payload)
        const pending = pendingPostCompactionContext.get(sessionId)
        if (pending) {
          pendingPostCompactionContext.delete(sessionId)
          const before = (pending.beforePayload ?? {}) as { messages?: unknown }
          const after = payload as { messages?: unknown; tools?: unknown }
          const beforeMessages = Array.isArray(before.messages) ? before.messages : []
          const afterMessages = Array.isArray(after.messages) ? after.messages : []
          const beforeRolling = rollingMessageHashes(beforeMessages)
          const afterRolling = rollingMessageHashes(afterMessages)
          const stableMessages = sharedPrefixLength(beforeRolling, afterRolling)
          const branchEntries = ctx.sessionManager.getBranch() as SessionEntry[]
          const branchCheckpoints = preserveDialogueStates(branchEntries).map((state, index) => ({
            number: state.details?.checkpoint?.number ?? index + 1,
            hash: shortHash(state.summary),
          }))
          loggerFor(options).record("post_compaction_context", {
            sessionId,
            checkpointNumber: pending.checkpointNumber,
            branchCheckpoints,
            cachePrefix: {
              stableMessages,
              beforeMessages: beforeMessages.length,
              afterMessages: afterMessages.length,
              firstDivergenceMessage:
                stableMessages < Math.min(beforeMessages.length, afterMessages.length)
                  ? stableMessages
                  : null,
            },
            context: {
            messageIndex: debugContextIndex(afterMessages, 1, branchEntries),
            tools: providerToolNames(after.tools),
            },
          })
        }
        if (options.debugPayloads === true && dumpNextLive.delete(sessionId)) {
          loggerFor(options).record("payload_dump", {
            sessionId,
            variant: "live_after",
            payload: compactPayloadForLog(payload),
          })
        }
        recentLivePayloads.push({ sessionId, payload })
        if (recentLivePayloads.length > 4) recentLivePayloads.shift()
      }
    } catch {
      /* logging must never break the request path */
    }
    return undefined
  })

  // Capture (and log, redacted) the exact headers pi assembles for live
  // provider requests. Handlers receive the final bag and may mutate it in
  // place; the return value is ignored, so we only read. pi deletes headers
  // whose value is null, hence the loose value type on capture.
  pi.on("before_provider_headers", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId()
    try {
      liveHeaders.set(sessionId, { ...event.headers })
    } catch {
      /* capture must never break the request path */
    }
    try {
      const options = optionsFor(ctx)
      if (options.debug !== true || !options.debugFile) return
      loggerFor(options).record("provider_headers", {
        sessionId,
        summary: false,
        headers: redactHeaders(event.headers),
      })
    } catch {
      /* logging must never break the request path */
    }
  })

  // Response headers of live requests — replica/routing echoes to diff
  // against the summarization request's `provider_response` record.
  pi.on("after_provider_response", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId()
    try {
      const options = optionsFor(ctx)
      if (options.debug !== true || !options.debugFile) return
      loggerFor(options).record("provider_response", {
        sessionId,
        summary: false,
        status: event.status,
        headers: redactHeaders(event.headers),
      })
    } catch {
      /* logging must never break the request path */
    }
  })

  const handleCompaction = async (
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ): Promise<SessionBeforeCompactResult | undefined> => {
    const options = optionsFor(ctx)
    const log = loggerFor(options)
    // Pi compacts whether or not we win the hook, so the next live request is
    // the "after" side of the payload dump on every path.
    const sessionId = ctx.sessionManager.getSessionId()
    if (options.enabled === false) return
    const model = ctx.model
    if (!model || !isModelAllowed(options.models, model.provider, model.id)) return
    compactionFailureReasons.delete(sessionId)
    const preserveEvent = event as SessionBeforeCompactEvent & {
      preserveTailStartEntryId?: string
      preserveTailMessageCount?: number
      preserveTailEstimatedTokens?: number
      preserveTailRawEstimatedTokens?: number
      preserveTailAgentMessages?: AgentMessage[]
      preservePrefixTokens?: number
      // Delta-only selection is automatic in preserve mode.
      }
    const nativeManualPreserve =
      options.preserveDialogue === true &&
      event.reason === "manual" &&
      !preserveEvent.preserveTailStartEntryId
    if (
      options.preserveDialogue === true &&
      !preserveEvent.preserveTailStartEntryId &&
      !nativeManualPreserve
    ) {
      log.record("native_compaction_cancelled", {
        sessionId,
        reason: event.reason,
        tokensBefore: event.preparation.tokensBefore,
      })
      return { cancel: true }
    }
    if (options.preserveDialogue === true) {
      const branch: CompactionBranch =
        dynamicCompactions.get(sessionId) ?? (nativeManualPreserve ? "manual" : "reserve threshold")
      try {
        const tokens = compactionMessageTokens(ctx, event.branchEntries as SessionEntry[])
        const scope = preserveDeltaScope(
          event.branchEntries as SessionEntry[],
          preserveEvent.preserveTailStartEntryId,
        )
        if (nativeManualPreserve && scope.rawEntryCount === 0) {
          log.record("manual_compaction_no_raw_state", {
            sessionId,
            tokensBefore: event.preparation.tokensBefore,
          })
          notify(ctx, "[cache-compact] manual\nnothing technical to compact", "info")
          return { cancel: true }
        }
        const remainingRawTokens = preserveEvent.preserveTailRawEstimatedTokens ?? 0
        const compactedRawTokens = Math.max(0, tokens.newRawCompactable - remainingRawTokens)
        const usage = ctx.getContextUsage()
        const contextTokens =
          usage?.tokens === null || usage === undefined ? undefined : usage.tokens
        pendingCompactionUi.set(sessionId, {
        branch,
        tokens,
        scope,
        compactedRawTokens,
        remainingRawTokens,
        tailEstimatedTokens: preserveEvent.preserveTailEstimatedTokens ?? 0,
        unreportedScale: Math.max(1, tokens.scale),
        ...(preserveEvent.preservePrefixTokens === undefined
        ? {}
        : { reportedPrefixTokens: preserveEvent.preservePrefixTokens }),
        ...(contextTokens === undefined ? {} : { contextTokens }),
        ...(usage === undefined ? {} : { contextWindow: usage.contextWindow }),
        })
        const context =
          contextTokens === undefined || usage === undefined
            ? ""
            : ` | context ${contextTokens}/${usage.contextWindow} tok`
        notify(
          ctx,
          `[cache-compact] ${branch}\npreserved dialogue: ${tokens.preservedDialogue} tok | historical checkpoints: ${tokens.historicalCheckpoints} tok (${tokens.checkpointCount}) | new raw compactable: ${tokens.newRawCompactable} tok${context}`,
          event.reason === "overflow" ? "warning" : "info",
        )
      } catch {
        pendingCompactionUi.delete(sessionId)
        notify(ctx, `[cache-compact] ${branch}`, event.reason === "overflow" ? "warning" : "info")
      }
    }
    if (options.debug === true && options.debugFile && options.debugPayloads === true) {
      dumpNextLive.add(sessionId)
    }

    const preserveFallback = (
      message: string,
      data: Record<string, unknown>,
    ): SessionBeforeCompactResult | undefined => {
      if (options.preserveDialogue === true) {
        dumpNextLive.delete(sessionId)
        const detail =
          typeof data.reason === "string"
            ? `${message}: ${data.reason}`
            : typeof data.error === "string"
              ? `${message}: ${data.error}`
              : message
        compactionFailureReasons.set(sessionId, detail)
        log.both(`${message}; cancelling compaction to preserve dialogue`, data)
        return { cancel: true }
      }
      log.both(`${message}; leaving compaction to Pi`, data)
      return undefined
    }

    const summarizer = resolveSummarizer(ctx, options, model)
    const summaryContextWindow = (summarizer as { contextWindow?: number }).contextWindow
    const summaryReserveTokens =
      options.preserveDialogue === true
        ? reserveFor(ctx, model)
        : event.preparation.settings?.reserveTokens

    // Preserve mode checkpoints only the older raw delta. The newest completed
    // assistant/tool batch is an atomic raw tail and must stay out of this summary;
    // Pi's firstKeptEntryId / keepRecentTokens do not define that boundary.
    const projection = ctx.sessionManager.buildSessionProjection()
    const projectedAgent = projection.messages as AgentMessage[]
    const effectiveAgent = effectiveAgentMessages(
      projectedAgent,
      event.branchEntries as SessionEntry[],
    )
    const nativeDroppedAgent = (messagesBeforeEntry(
      projection.entries,
      event.preparation.firstKeptEntryId,
    ) ?? [
      ...event.preparation.messagesToSummarize,
      ...event.preparation.turnPrefixMessages,
    ]) as AgentMessage[]
    // preserveEvent is defined once at the compaction boundary above.
    const branchEntries = event.branchEntries as SessionEntry[]
    let preserveTailStartEntryId =
    options.preserveDialogue === true ? preserveEvent.preserveTailStartEntryId : undefined
    let preserveDeltaAgent = preserveDialogueDeltaMessages(branchEntries, preserveTailStartEntryId)
    let preserveScope =
    options.preserveDialogue === true
    ? preserveDeltaScope(branchEntries, preserveTailStartEntryId)
    : undefined
    let summaryScopeAgent =
    options.preserveDialogue === true ? preserveDeltaAgent : nativeDroppedAgent
    const liveMessages = convertToLlm(effectiveAgent)
    const observedCount = liveRequestCounts.get(sessionId)
    const preserveTailMessageCount =
    options.preserveDialogue === true ? (preserveEvent.preserveTailMessageCount ?? 0) : 0
    const requestMessages =
    preserveTailMessageCount > 0 && preserveTailMessageCount < liveMessages.length
    ? liveMessages.slice(0, liveMessages.length - preserveTailMessageCount)
    : observedCount !== undefined && observedCount > 0 && observedCount < liveMessages.length
    ? liveMessages.slice(0, observedCount)
    : liveMessages
    const planSummary = (preferDeltaOnly = false): SummaryRequestPlan =>
    planSummaryRequest({
    liveMessages,
    requestMessages,
    requestPromptTokens:
    options.preserveDialogue === true ? preserveEvent.preservePrefixTokens : undefined,
    droppedMessages: convertToLlm(summaryScopeAgent),
    keptCount:
    options.preserveDialogue === true
    ? preserveTailMessageCount
    : projection.messages.length - nativeDroppedAgent.length,
    turnPrefixCount:
    options.preserveDialogue === true ? 0 : (event.preparation.turnPrefixMessages?.length ?? 0),
    ...(options.preserveDialogue !== true && event.preparation.previousSummary
    ? { previousSummary: event.preparation.previousSummary }
    : undefined),
    options,
    customInstructions: event.customInstructions,
    preserveUserMessageOrdinals: preserveScope?.coveredUserMessages,
    preferDeltaOnly,
    contextWindow: summaryContextWindow,
    reserveTokens: summaryReserveTokens,
    modelMaxTokens: (summarizer as { maxTokens?: number }).maxTokens,
    })
    const desiredPreserveOutput =
    options.preserveDialogue === true
    ? summaryOutputCap({
    reserveTokens: summaryReserveTokens,
    modelMaxTokens: (summarizer as { maxTokens?: number }).maxTokens,
    preserveDialogue: true,
    })
    : undefined
    const selectDeltaChunk = (): SummaryRequestPlan | undefined => {
    if (options.preserveDialogue !== true || desiredPreserveOutput === undefined) return undefined
    const candidates = preserveDeltaTailCandidates(branchEntries, preserveTailStartEntryId)
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidateTailStart = candidates[index]
    const candidateDelta = preserveDialogueDeltaMessages(branchEntries, candidateTailStart)
    const candidateScope = preserveDeltaScope(branchEntries, candidateTailStart)
    const candidatePlan = planSummaryRequest({
    liveMessages,
    requestMessages,
    requestPromptTokens: preserveEvent.preservePrefixTokens,
    droppedMessages: convertToLlm(candidateDelta),
    keptCount: preserveTailMessageCount,
    turnPrefixCount: 0,
    options,
    customInstructions: event.customInstructions,
    preserveUserMessageOrdinals: candidateScope.coveredUserMessages,
    preferDeltaOnly: true,
    contextWindow: summaryContextWindow,
    reserveTokens: summaryReserveTokens,
    modelMaxTokens: (summarizer as { maxTokens?: number }).maxTokens,
    })
    if (
    candidatePlan.shape !== "delta-only" ||
    !candidatePlan.requestFits ||
    candidatePlan.maxTokens < desiredPreserveOutput
    ) {
    continue
    }
    preserveTailStartEntryId = candidateTailStart
    preserveDeltaAgent = candidateDelta
    preserveScope = candidateScope
    summaryScopeAgent = candidateDelta
    notify(
    ctx,
    "[cache-compact] technical delta is too large for one summary; compacting the older part and keeping the newest part raw",
    "info",
    )
    log.record("summary_delta_chunked", {
    sessionId,
    rawTailStartEntryId: candidateTailStart,
    compactedRawEntryCount: candidateScope.rawEntryCount,
    requestShape: candidatePlan.shape,
    maxTokens: candidatePlan.maxTokens,
    })
    return candidatePlan
    }
    return undefined
    }
    let plan = planSummary()

    // When the complete delta-only request cannot keep the normal summary reserve,
    // compact the largest safe older prefix and carry the newest suffix forward raw.
    if (
    options.preserveDialogue === true &&
    desiredPreserveOutput !== undefined &&
    (!plan.requestFits || (plan.shape === "delta-only" && plan.maxTokens < desiredPreserveOutput))
    ) {
    plan = selectDeltaChunk() ?? plan
    }

    if (options.preserveDialogue === true && !plan.requestFits) {
    return preserveFallback("technical delta does not fit even without the cached prefix", {
    sessionId,
    tokensBefore: event.preparation.tokensBefore,
    contextWindow: summaryContextWindow,
    reserveTokens: summaryReserveTokens,
    requestShape: plan.shape,
    summaryOutputTokens: plan.maxTokens,
    })
    }

    // The rewind is the one shape that has never reused a cache, and it costs
    // the whole conversation as a cold prefill — more than Pi's own small
    // summary, which is why it is now a deliberate opt-in.
    if (plan.rewindFallback && options.rewindWhenNeeded !== true) {
      return preserveFallback("only the rewinding shape fits", {
        sessionId,
        tokensBefore: event.preparation.tokensBefore,
      })
    }
    if (options.preserveDialogue === true && plan.shape === "delta-only") {
    notify(
    ctx,
    "[cache-compact] cached summary request does not fit safely; summarizing only the technical delta",
    "info",
    )
    }
    const askHash = shortHash(plan.ask)

    // Effort for the summary ask: explicit config, else whatever the last
    // live request of this session actually sent — the cached prefix is keyed
    // by the sent value, so a mid-session /thinking change makes the live
    // request itself re-prefill, but our ask still matches the newest prefix.
    const reasoningEffort = resolveSummaryReasoningEffort(
      options.summaryReasoningEffort,
      liveEfforts.get(sessionId),
      )
      const toolChoiceFor = (requestPlan: SummaryRequestPlan, textOnly = false) =>
      resolveSummaryToolChoice(
      options.toolChoice,
      liveToolChoices.get(sessionId),
      textOnly || requestPlan.shape === "delta-only",
      )

      // Fingerprint our summarization request at the exact payload pi-ai sends,
    // tagged so the debug file can be diffed against the live-request
    // fingerprints from before_provider_request.
    const recordSummaryPayload = (
      payload: unknown,
      info: {
        hasLeadingSystemMessage: boolean
        droppedCount: number
        sentCount: number
        requestShape: SummaryRequestShape
      },
    ): void => {
      if (options.debug !== true || !options.debugFile) return
      try {
        const fingerprint = fingerprintPayload(payload)
        fingerprint.summary = true
        // Which code path produced the system prompt: "recorded" reuses the
        // transcript's system message, "synthesized" rebuilds it from
        // getSystemPrompt() + live tool declarations. Divergence between the
        // branches and the live prefix looks different, so record it.
        fingerprint.systemSource = info.hasLeadingSystemMessage ? "recorded" : "synthesized"
        // Request shape: "continuation" sends the whole live message list (the
        // append-only cache's forward extension) and "dropped" only the span
        // compaction discards (a rewind, so a guaranteed cold prefill on such a
        // server). `droppedCount` is what the summary should cover; `sentCount`
        // is what the request actually carried.
        fingerprint.requestShape = info.requestShape
        fingerprint.droppedCount = info.droppedCount
        fingerprint.sentCount = info.sentCount
        log.record("provider_request", {
          sessionId,
          activeModel: `${model.provider}/${model.id}`,
          ...fingerprint,
        })
        if (options.debugPayloads === true) {
          // The comparison pair: the last live request before compaction and our
          // summarization request. Messages stay byte-for-byte comparable; provider
          // tool declarations are reduced to names before either payload is logged.
          const lastLive = [...recentLivePayloads]
            .reverse()
            .find((entry) => entry.sessionId === sessionId)
          if (lastLive) {
            log.record("payload_dump", {
              sessionId,
              variant: "live_before",
              payload: compactPayloadForLog(lastLive.payload),
            })
          }
          log.record("payload_dump", {
            sessionId,
            variant: "summarization",
            systemSource: info.hasLeadingSystemMessage ? "recorded" : "synthesized",
            requestShape: info.requestShape,
            payload: compactPayloadForLog(payload),
          })
        }
      } catch {
        /* never break the request path over logging */
      }
    }

    // Mirror the live request headers onto the ask (transport-level twin,
    // see replayableHeaders) and log what we will send, redacted.
    let requestHeaders: Record<string, string | null> | undefined
    try {
      requestHeaders = replayableHeaders(liveHeaders.get(sessionId))
    } catch {
      requestHeaders = undefined
    }
    if (options.debug === true && options.debugFile) {
      log.record("provider_headers", {
        sessionId,
        summary: true,
        liveCaptured: liveHeaders.has(sessionId),
        headers: redactHeaders(requestHeaders),
      })
    }

    try {
      log.record("summary_start", {
        sessionId,
        summarizer: `${summarizer.provider}/${summarizer.id}`,
        askHash,
        maxTokens: plan.maxTokens,
        cacheRetention: options.cacheRetention ?? "short",
        toolChoice: toolChoiceFor(plan),
        reasoningEffort,
        // The shape the request actually uses; `continuation` is the configured
        // option, which is ignored when the continuation would not fit.
        requestShape: plan.shape,
        // Pi's artifact shape: a split turn adds the "Turn Context (split turn)"
        // section, and a previous summary switches the prompt to Pi's update
        // variant.
        splitTurn: plan.split !== undefined,
        previousSummary: Boolean(event.preparation.previousSummary),
        continuationOption: options.continuation !== false,
        sentCount: plan.messages.length,
        droppedCount: plan.droppedMessages.length,
        tokensBefore: event.preparation.tokensBefore,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
      })
      const summaryResponseRejection = (candidate: AssistantMessage): string | undefined => {
        const base = summaryRejection(candidate)
        if (base || options.preserveDialogue !== true) return base
        return preserveSummaryOrdinalRejection(
          extractSummaryText(candidate.content),
          preserveScope?.coveredUserMessages ?? [],
        )
      }

      pendingAskHashes.add(askHash)
      const startedAt = Date.now()
      let response: AssistantMessage
      try {
        response = await generateSummary(
          pi,
          ctx,
          event,
          options,
          summarizer,
          reasoningEffort,
          toolChoiceFor(plan),
          plan,
          recordSummaryPayload,
          requestHeaders,
        )
      } finally {
        // The ask is deterministic, so its hash is known up front; the
        // returned `ask` is only used for that hash, which we already have.
        pendingAskHashes.delete(askHash)
      }
      const durationMs = Date.now() - startedAt
      let rejection = summaryResponseRejection(response)
      const retryableSummaryReply = (reason: string | undefined): boolean =>
        reason === NO_TEXT_REPLY ||
        reason === PARSED_TOOL_CALL_REPLY ||
        reason === TOOL_CALL_TEXT_REPLY
      const retryUnusableSummary = async (basePlan: SummaryRequestPlan): Promise<void> => {
        if (!retryableSummaryReply(rejection)) return
        notify(ctx, "[cache-compact] summary response was unusable; retrying once", "info")
        log.both("summary reply was unusable; retrying once", {
          reason: rejection,
          sessionId,
          stopReason: response.stopReason,
          usage: response.usage,
          blocks: describeContent(response.content, options.debugPayloads === true),
        })
        const retryPlan: SummaryRequestPlan = {
          ...basePlan,
          // Keep the same request shape/cache prefix and append a concrete text-only nudge.
          ask: `${basePlan.ask}\n\nReminder: reply with the summary text itself. Do not call any tools, do not write tool-call syntax, do not leave the summary in your reasoning, and do not end your turn before writing it — start with the summary's first heading.`,
        }
        const retryStartedAt = Date.now()
        try {
          response = await generateSummary(
            pi,
            ctx,
            event,
            options,
            summarizer,
            reasoningEffort,
            toolChoiceFor(retryPlan, true),
            retryPlan,
            recordSummaryPayload,
            requestHeaders,
          )
          rejection = summaryResponseRejection(response)
          log.record("summary_retry", {
            sessionId,
            durationMs: Date.now() - retryStartedAt,
            stopReason: response.stopReason,
            blocks: describeContent(response.content, options.debugPayloads === true),
            cacheRead: response.usage.cacheRead,
            reason: rejection,
          })
        } catch (error) {
          log.record("summary_retry", { sessionId, error: String(error) })
          rejection = String(error)
        }
      }
      await retryUnusableSummary(plan)

      // Any cache-friendly summary that exhausts its own output budget gets one
      // delta-only retry. This is independent of how the live assistant turn ended:
      // the summary response itself proves that the cached request had too little room.
      if (
        rejection !== undefined &&
        response.stopReason === "length" &&
        options.preserveDialogue === true &&
        plan.shape !== "delta-only"
      ) {
        const forwardShape = plan.shape
        let deltaOnlyPlan = planSummary(true)
        if (
          desiredPreserveOutput !== undefined &&
          (!deltaOnlyPlan.requestFits || deltaOnlyPlan.maxTokens < desiredPreserveOutput)
        ) {
          deltaOnlyPlan = selectDeltaChunk() ?? deltaOnlyPlan
        }
        log.record("summary_delta_only_retry_start", {
          sessionId,
          forwardShape,
          requestShape: deltaOnlyPlan.shape,
          requestFits: deltaOnlyPlan.requestFits,
          maxTokens: deltaOnlyPlan.maxTokens,
        })
        if (deltaOnlyPlan.shape === "delta-only" && deltaOnlyPlan.requestFits) {
          notify(
            ctx,
            "[cache-compact] cached summary hit its output limit; retrying with only the technical delta",
            "info",
          )
          plan = deltaOnlyPlan
          const deltaOnlyAskHash = shortHash(plan.ask)
          pendingAskHashes.add(deltaOnlyAskHash)
          const deltaOnlyStartedAt = Date.now()
          let deltaOnlyError: string | undefined
          try {
            response = await generateSummary(
              pi,
              ctx,
              event,
              options,
              summarizer,
              reasoningEffort,
              toolChoiceFor(plan),
              plan,
              recordSummaryPayload,
              requestHeaders,
            )
            rejection = summaryResponseRejection(response)
          } catch (error) {
            deltaOnlyError = String(error)
            rejection = deltaOnlyError
          } finally {
            pendingAskHashes.delete(deltaOnlyAskHash)
          }
          log.record("summary_delta_only_retry_result", {
            sessionId,
            durationMs: Date.now() - deltaOnlyStartedAt,
            stopReason: deltaOnlyError ? undefined : response.stopReason,
            reason: rejection,
            error: deltaOnlyError,
          })
          if (!deltaOnlyError) await retryUnusableSummary(plan)
        }
      }
      if (rejection) {
        return preserveFallback("summary rejected", {
          sessionId,
          reason: rejection,
          stopReason: response.stopReason,
          usage: response.usage,
          blocks: describeContent(response.content, options.debugPayloads === true),
        })
      }
      // Pi appends a machine-computed file list to every summary. In preserve
      // mode this is checkpoint-local state: historical checkpoint appendices are
      // immutable and must not be merged into the new delta checkpoint.
      const { readFiles, modifiedFiles } =
        options.preserveDialogue === true
          ? computeFileListsFromMessages(preserveDeltaAgent)
          : computeFileLists(event.preparation.fileOps)
      const summary =
        extractSummaryText(response.content) + formatFileOperations(readFiles, modifiedFiles)
      const details: CacheCompactDetails = {
        readFiles,
        modifiedFiles,
        ...(options.preserveDialogue === true
          ? { cacheCompact: PRESERVE_DIALOGUE_MARKER }
          : undefined),
      }
      // Cache usage remains available in summary_result diagnostics below.

      if (options.preserveDialogue === true) {
      const rawTailStartEntryId = preserveTailStartEntryId
      const scope = preserveScope ?? preserveDeltaScope(branchEntries, rawTailStartEntryId)
      details.checkpoint = {
      summary,
      tokensBefore: event.preparation.tokensBefore,
      number: scope.nextCheckpointNumber,
      coveredUserMessages: scope.coveredUserMessages,
      ...(rawTailStartEntryId ? { rawTailStartEntryId } : {}),
      }
        const tokens = compactionMessageTokens(ctx, branchEntries)
        const preview = nativeManualPreserve
          ? preservedContextMessages([
              ...branchEntries,
              {
                type: "compaction",
                id: "__cache_compact_manual_preview__",
                parentId: null,
                timestamp: new Date().toISOString(),
                summary,
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
                details,
              } as SessionEntry,
            ])
          : previewPreservedContextAfterCheckpoint({
              branchEntries,
              summary,
              tokensBefore: event.preparation.tokensBefore,
              details,
              ...(rawTailStartEntryId ? { rawTailStartEntryId } : undefined),
            })
        const rawTailAlreadyInBranch =
          rawTailStartEntryId !== undefined &&
          branchEntries.some((entry) => "id" in entry && entry.id === rawTailStartEntryId)
        const pendingRawTail = rawTailAlreadyInBranch
          ? []
          : (preserveEvent.preserveTailAgentMessages ?? [])
        let systemCount = 0
        while (effectiveAgent[systemCount]?.role === "system") systemCount += 1
        const afterAgent = [...effectiveAgent.slice(0, systemCount), ...preview, ...pendingRawTail]
        const afterMessages = convertToLlm(afterAgent)
        const estimatedAfterMessages = Math.ceil(estimateMessagesTokens(afterMessages) * tokens.scale)
        const unreportedScale = Math.max(1, tokens.scale)
        const checkpointMessage = nativeManualPreserve
          ? ({
              role: "compactionSummary",
              summary,
              tokensBefore: event.preparation.tokensBefore,
              timestamp: Date.now(),
            } as AgentMessage)
          : ({
              role: "custom",
              customType: PRESERVE_DIALOGUE_CHECKPOINT_TYPE,
              content: "## Tool Context Checkpoint #" + scope.nextCheckpointNumber + "\n\n" + summary,
              display: false,
              timestamp: Date.now(),
            } as AgentMessage)
        const checkpointBaseTokens = estimateMessagesTokens(convertToLlm([checkpointMessage]))
        const newCheckpointTokens = Math.ceil(checkpointBaseTokens * unreportedScale)
        const newCheckpointCalibratedTokens = Math.ceil(
          checkpointBaseTokens * tokens.calibratedScale,
        )
        const compactedRawAgent = preserveDeltaAgent.filter(
          (message) =>
            message.role === "toolResult" ||
            (message.role === "assistant" && !isPreservedAssistantReply(message)),
        )
        const compactedRawBaseTokens = estimateMessagesTokens(convertToLlm(compactedRawAgent))
        const compactedRawEstimate = Math.ceil(compactedRawBaseTokens * tokens.scale)
        const compactedRawCalibratedEstimate = Math.ceil(
          compactedRawBaseTokens * tokens.calibratedScale,
        )
        const compactedRaw =
          preserveDeltaAgent.length === 0 && tokens.newRawCompactable > 0
            ? Math.max(
                0,
                tokens.newRawCompactable - (preserveEvent.preserveTailRawEstimatedTokens ?? 0),
              )
            : compactedRawEstimate
        const compactedRawCalibrated =
          preserveDeltaAgent.length === 0 && compactedRaw > 0
            ? Math.ceil(compactedRaw * (tokens.calibratedScale / tokens.scale))
            : compactedRawCalibratedEstimate
        const remainingRawCompactable = Math.max(0, tokens.newRawCompactable - compactedRaw)
        const pendingUi = pendingCompactionUi.get(sessionId)
        if (pendingUi) {
          pendingUi.scope = scope
          pendingUi.compactedRawTokens = compactedRaw
          pendingUi.compactedRawCalibratedTokens = compactedRawCalibrated
          pendingUi.remainingRawTokens = remainingRawCompactable
        }
        const checkpointHashes = preserveDialogueStates(branchEntries).map((state, index) => ({
          number: state.details?.checkpoint?.number ?? index + 1,
          entryId: "id" in state.entry ? state.entry.id : undefined,
          hash: shortHash(state.summary),
        }))
        const beforeStructural = convertToLlm(effectiveAgent)
        const beforeRolling = rollingMessageHashes(beforeStructural)
        const afterRolling = rollingMessageHashes(afterMessages)
        const stablePrefixMessages = sharedPrefixLength(beforeRolling, afterRolling)
        const stablePrefixTokens = Math.ceil(
          estimateMessagesTokens(afterMessages.slice(0, stablePrefixMessages)) * tokens.scale,
        )
        const firstDivergenceMessage =
          stablePrefixMessages < Math.min(beforeRolling.length, afterRolling.length)
            ? stablePrefixMessages
            : null
        const divergenceBefore =
          firstDivergenceMessage === null ? undefined : beforeStructural[firstDivergenceMessage]
        const divergenceAfter =
          firstDivergenceMessage === null ? undefined : afterMessages[firstDivergenceMessage]
        const lastLive = [...recentLivePayloads]
          .reverse()
          .find((entry) => entry.sessionId === sessionId)
        const lastLiveRecord = (lastLive?.payload ?? {}) as { tools?: unknown }
        const toolDeclarations = Array.isArray(lastLiveRecord.tools) ? lastLiveRecord.tools : []
        const systemPromptTokens = Math.ceil(
          estimateMessagesTokens(beforeStructural.filter((message) => message.role === "system")) *
            tokens.scale,
        )
        const toolDeclarationTokens = Math.ceil(
          estimateMessagesTokens(toolDeclarations) * tokens.scale,
        )
        const providerOverhead = Math.max(0, event.preparation.tokensBefore - tokens.nonSystemTotal)
        const otherProviderOverhead = Math.max(
          0,
          providerOverhead - systemPromptTokens - toolDeclarationTokens,
        )
        const estimatedAfterStructural = estimatedAfterMessages + toolDeclarationTokens
        const estimatedAfterAnchored =
          preserveEvent.preservePrefixTokens === undefined
            ? undefined
          : Math.max(0, preserveEvent.preservePrefixTokens - compactedRaw) +
            newCheckpointTokens +
            (preserveEvent.preserveTailEstimatedTokens ?? 0)
        const estimatedAfter =
          estimatedAfterAnchored === undefined
            ? estimatedAfterStructural
            : Math.max(estimatedAfterStructural, estimatedAfterAnchored)
        const calibrationRatio = tokens.calibratedScale / tokens.scale
        const tailAfterPrefixCalibrated = Math.ceil(
          (preserveEvent.preserveTailEstimatedTokens ?? 0) * calibrationRatio,
        )
        const estimatedAfterStructuralCalibrated = Math.ceil(
          estimatedAfterStructural * calibrationRatio,
        )
        const estimatedAfterAnchoredCalibrated =
          preserveEvent.preservePrefixTokens === undefined
            ? undefined
            : Math.max(0, preserveEvent.preservePrefixTokens - compactedRawCalibrated) +
              newCheckpointCalibratedTokens +
              tailAfterPrefixCalibrated
        const estimatedAfterCalibrated =
          estimatedAfterAnchoredCalibrated === undefined
            ? estimatedAfterStructuralCalibrated
            : Math.max(estimatedAfterStructuralCalibrated, estimatedAfterAnchoredCalibrated)

        log.record("preserve_compaction", {
          sessionId,
          trigger: pendingCompactionUi.get(sessionId)?.branch,
          checkpoint: {
            number: scope.nextCheckpointNumber,
            coveredUserMessages: scope.coveredUserMessages,
            summary,
            summaryHash: shortHash(summary),
            tokens: newCheckpointTokens,
          },
          historicalCheckpoints: checkpointHashes,
          toolDeclarations: providerToolNames(toolDeclarations),
          scope: {
            afterCheckpoint: scope.checkpointCount || null,
            coveredUserMessages: scope.coveredUserMessages,
            rawMessageCount: preserveDeltaAgent.length,
            rawEntryCount: scope.rawEntryCount,
            rawEntryIds: scope.rawEntryIds,
            firstRawEntryId: scope.firstRawEntryId ?? null,
            lastRawEntryId: scope.lastRawEntryId ?? null,
          },
          tokens: {
            providerContextBefore: event.preparation.tokensBefore,
            reportedPrefixTokens: preserveEvent.preservePrefixTokens ?? null,
            estimateScale: tokens.scale,
            providerCalibratedScale: tokens.calibratedScale,
            unreportedScale,
            estimatedNonSystemBefore: tokens.nonSystemTotal,
            providerPromptOverhead: providerOverhead,
            estimatedSystemPrompt: systemPromptTokens,
            estimatedToolDeclarations: toolDeclarationTokens,
            estimatedOtherProviderOverhead: otherProviderOverhead,
            preservedDialogue: tokens.preservedDialogue,
            preservedUserMessages: tokens.preservedUserMessages,
            preservedAssistantText: tokens.preservedAssistantText,
            historicalCheckpoints: tokens.historicalCheckpoints,
            historicalCheckpointCount: tokens.checkpointCount,
            newRawCompactable: tokens.newRawCompactable,
            compactedRaw,
            compactedRawCalibrated,
            rawToolCalls: tokens.rawToolCalls,
            rawToolResults: tokens.rawToolResults,
            rawReasoning: tokens.rawReasoning,
            rawOther: tokens.rawOther,
            newCheckpoint: newCheckpointTokens,
            newCheckpointCalibrated: newCheckpointCalibratedTokens,
            remainingRawCompactable,
            tailAfterPrefix: preserveEvent.preserveTailEstimatedTokens ?? 0,
            tailAfterPrefixCalibrated,
            estimatedContextAfterStructuralCalibrated: estimatedAfterStructuralCalibrated,
            estimatedContextAfterAnchoredCalibrated: estimatedAfterAnchoredCalibrated ?? null,
            estimatedContextAfterStructural: estimatedAfterStructural,
            estimatedContextAfterAnchored: estimatedAfterAnchored ?? null,
            estimatedContextAfterCalibrated: estimatedAfterCalibrated,
            estimatedContextAfter: estimatedAfter,
            estimatedCompactedRaw: compactedRaw,
            compression: newCheckpointTokens > 0 ? compactedRaw / newCheckpointTokens : null,
          },
          cachePrefixPreview: {
            stableMessages: stablePrefixMessages,
            stableEstimatedTokens: stablePrefixTokens,
            firstDivergenceMessage,
            firstDivergence:
              firstDivergenceMessage === null
                ? null
                : {
                    index: firstDivergenceMessage,
                    reason:
                      "preserve compaction removed or changed raw technical state at this message",
                    beforeRole: (divergenceBefore as { role?: unknown } | undefined)?.role,
                    beforeKind: debugMessageKind(divergenceBefore),
                    beforeHash: shortHash(divergenceBefore),
                    afterRole: (divergenceAfter as { role?: unknown } | undefined)?.role,
                    afterKind: debugMessageKind(divergenceAfter),
                    afterHash: shortHash(divergenceAfter),
                  },
          },
          ...(options.debugPayloads === true
          ? {
          contextBefore: snapshot(beforeStructural),
          contextAfter: snapshot(afterMessages),
          }
          : {}),
          contextIndex: {
            before: debugContextIndex(beforeStructural, tokens.scale, branchEntries),
            after: debugContextIndex(afterMessages, tokens.scale, branchEntries, {
              number: scope.nextCheckpointNumber,
              summary,
            }),
          },
        })

        if (options.debug === true && options.debugFile) {
          pendingPostCompactionContext.set(sessionId, {
            checkpointNumber: scope.nextCheckpointNumber,
            beforePayload: lastLive?.payload,
          })
        }
      }

      log.both("wrote cache-friendly summary", {
        sessionId,
        chars: summary.length,
        cacheRead: response.usage.cacheRead,
        cacheWrite: response.usage.cacheWrite,
        input: response.usage.input,
        durationMs: Date.now() - startedAt,
        summarizer: `${summarizer.provider}/${summarizer.id}`,
      })
      log.record("summary_result", {
        sessionId,
        askHash,
        durationMs,
        stopReason: response.stopReason,
        chars: summary.length,
        usage: response.usage,
        cacheRead: response.usage.cacheRead,
        cacheWrite: response.usage.cacheWrite,
      })
      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: response.usage,
          details,
        },
      }
    } catch (error) {
      return preserveFallback("summary request failed", {
        sessionId,
        error: String(error),
      })
    }
  }

  pi.on("session_before_compact", handleCompaction)

  pi.on("session_compact", (event, ctx) => {
    if (
      event.reason !== "manual" ||
      !event.fromExtension ||
      !isPreserveDialogueCompaction(event.compactionEntry as SessionEntry)
    ) {
      return
    }
    reportCompactionComplete(
      ctx,
      "manual",
      event.compactionEntry.summary,
      event.compactionEntry.tokensBefore,
    )
    try {
      loggerFor(optionsFor(ctx)).record("manual_compaction_complete", {
        sessionId: ctx.sessionManager.getSessionId(),
        checkpointNumber:
          (event.compactionEntry.details as CacheCompactDetails | undefined)?.checkpoint?.number ?? null,
      })
    } catch {
      /* logging must never affect compaction */
    }
  })

  pi.on("session_compact_failed", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId()
    if (event.reason !== "manual" || !pendingCompactionUi.has(sessionId)) return
    reportCompactionFailure(ctx, "manual", event.aborted, event.errorMessage)
  })

  }

/**
 * pi-cache-compact — cache-friendly compaction for Pi.
 *
 * Pi's default compaction builds a brand-new request to write the summary: its
 * own system prompt, the transcript re-serialized into one user message, and
 * cache writes disabled. On a locally hosted model with prefix caching that can
 * never reuse the KV cache, so the whole conversation is re-prefilled just to
 * produce the summary — the expensive part you were trying to avoid.
 *
 * In preserve-dialogue mode the extension also owns normal checkpoint timing:
 * at safe `turn_end` boundaries it checks pressure and, when needed, writes
 * context edits plus a hidden checkpoint before the next provider request.
 * Pi threshold/overflow compaction still enters through `session_before_compact`.
 *
 * The summary itself is asked as a strict continuation of the live conversation
 * (same system prompt, same tools, same messages, one appended user turn), so a
 * prefix-caching server serves everything but the ask from cache. Normal mode
 * still only replaces Pi's summarization call.
 */

import { join } from "node:path"

import { CONFIG_DIR_NAME, DEFAULT_COMPACTION_SETTINGS, SettingsManager, convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent"
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeCompactResult,
  SessionEntry,
} from "@earendil-works/pi-coding-agent"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai"

import {
  activeToolDeclarations,
  buildSummaryContext,
  computeFileLists,
computeFileListsFromMessages,
  formatFileOperations,
  extractLiveReasoningEffort,
  extractSummaryText,
  isModelAllowed,
  messagesBeforeEntry,
  estimateMessagesTokens,
  planSummaryRequest,
  preserveCompactionBudget,
  PRESERVE_DYNAMIC_HEADROOM_MARGIN_TOKENS,
  replayableHeaders,
  resolveSummaryReasoningEffort,
  summaryRejection,
  summaryOutputCap,
  tokenScale,
  looksLikeToolCall,
  NO_TEXT_REPLY,
  TOOL_CALL_TEXT_REPLY,
  type LiveEffort,
  type SummaryRequestPlan,
  type SummaryRequestShape,
} from "./build.ts"
import { readOptions, type CacheCompactOptions } from "./config.ts"
import {
DebugLogger,
fingerprintPayload,
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
latestPreserveDialogueState,
preserveDeltaScope,
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
      return { type: "text", chars: block.text.length, ...(preview ? { head: head(block.text) } : undefined) }
    }
    if (block.type === "thinking") {
      const thinking = String(block.thinking ?? "")
      return { type: "thinking", chars: thinking.length, ...(preview ? { head: head(thinking) } : undefined) }
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

type CompactionBranch = "normal (dynamic 90%)" | "normal (before Pi threshold)" | "emergency (Pi threshold)" | "overflow recovery" | "manual /compact"

function compactionBranch(
reason: "manual" | "threshold" | "overflow",
dynamic: CompactionBranch | undefined,
): CompactionBranch {
if (dynamic) return dynamic
if (reason === "threshold") return "emergency (Pi threshold)"
if (reason === "overflow") return "overflow recovery"
return "manual /compact"
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

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
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
const scale = tokenScale(liveMessages)
const nonSystemMessages = liveMessages.filter((message) => message.role !== "system")
const estimate = (messages: readonly AgentMessage[]): number =>
Math.ceil(estimateMessagesTokens(convertToLlm([...messages])) * scale)

const dialogueMessages = preservedDialogueMessages(branchEntries)
const checkpointMessages = preservedCheckpointMessages(branchEntries)
const preservedUserMessages = estimate(dialogueMessages.filter((message) => message.role === "user"))
const preservedAssistantText = estimate(dialogueMessages.filter((message) => message.role === "assistant"))
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
}
}

function debugMessageKind(message: unknown): string {
const record = message && typeof message === "object" ? message as Record<string, unknown> : {}
const role = typeof record.role === "string" ? record.role : "unknown"
if (role !== "assistant") return role
const content = Array.isArray(record.content) ? record.content : []
const types = content
.map((block) => block && typeof block === "object" ? String((block as Record<string, unknown>).type ?? "") : "")
.filter(Boolean)
if (types.includes("toolCall")) return types.includes("text") ? "assistant-visible+tool-call" : "assistant-tool-call"
if (types.includes("thinking")) return types.includes("text") ? "assistant-visible+reasoning" : "assistant-reasoning"
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
const record = message && typeof message === "object" ? message as Record<string, unknown> : {}
const estimatedTokens = Math.ceil(
estimateMessagesTokens([message] as unknown as Parameters<typeof estimateMessagesTokens>[0]) * scale,
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
const matchedAnchors = stringAnchors(entry.message).filter((anchor) => serialized.includes(anchor))
if (matchedAnchors.length === 0) continue
const score = matchedAnchors.length * 1000 + matchedAnchors.reduce((sum, anchor) => sum + anchor.length, 0)
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
    tools: hasLeadingSystemMessage ? undefined : activeToolDeclarations(pi.getAllTools(), pi.getActiveTools()),
    messages,
    ask,
  })
  return await ctx.modelRegistry.complete(summarizer, context, {
    maxTokens: plan.maxTokens,
    signal: event.signal,
    cacheRetention: options.cacheRetention ?? "short",
    toolChoice: options.toolChoice ?? "none",
    // Mirror the effort the live prefix was actually sent with (see
    // extractLiveReasoningEffort): on servers that render the effort into the
    // prompt, any mismatch — including plain omission — misses the whole
    // prefix cache. Undefined reproduces the live omission.
    ...(reasoningEffort !== undefined ? { reasoningEffort } : undefined),
    // Replay the headers live requests send (session affinity, routing keys,
    // attribution) so the summarization ask is indistinguishable from a live
    // turn at the transport layer too. Live evidence: our ask was byte-
    // identical to a live request whose prefix hit the cache seconds before,
    // yet read 0 — the divergence, if it is in the request, can only live in
    // headers the payload dump cannot see.
    ...(requestHeaders !== undefined ? { headers: requestHeaders } : undefined),
    sessionId: ctx.sessionManager.getSessionId(),
    // Our own complete() call bypasses the extension runner, so
    // before_provider_request never sees it. pi-ai invokes onPayload with the
    // exact request params at the same point the hook fires for live requests,
    // which lets the debug file fingerprint both at the same level. Must not
    // return anything: a returned value would replace the outgoing payload.
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
    // Response headers of the summarization request (which replica answered,
    // cache echoes, via/chains) — the counterpart of the live
    // `after_provider_response` records, logged so the two can be diffed.
    onResponse: (response: { status: number; headers: Record<string, string> }) => {
      try {
        loggerFor(options).record("provider_response", {
          sessionId: ctx.sessionManager.getSessionId(),
          summary: true,
          status: response.status,
          headers: redactHeaders(response.headers),
        })
      } catch {
        /* logging must never break the request path */
      }
    },
  })
}

export default function cacheCompact(pi: ExtensionAPI): void {
  // Options are per working directory and read lazily, so a session started
  // after a config edit picks up the new file without a reload.
  const configs = new Map<string, CacheCompactOptions>()

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
    const checkpointSize = Math.ceil(
      estimateMessagesTokens(convertToLlm([checkpointMessage])) * pending.tokens.scale,
    )
    const reclaimed = Math.max(0, pending.tokens.newRawCompactable - checkpointSize)
    const compression =
      checkpointSize > 0 ? (pending.tokens.newRawCompactable / checkpointSize).toFixed(1) : "∞"

    const projectionMessages = ctx.sessionManager.buildSessionProjection().messages as AgentMessage[]
    const providerMessages = convertToLlm(projectionMessages)
    const systemPromptTokens = Math.ceil(
      estimateMessagesTokens(providerMessages.filter((message) => message.role === "system")) * pending.tokens.scale,
    )
    const lastLive = [...recentLivePayloads].reverse().find((entry) => entry.sessionId === sessionId)
    const lastLivePayload = (lastLive?.payload ?? {}) as { tools?: unknown }
    const toolDeclarations = Array.isArray(lastLivePayload.tools)
      ? lastLivePayload.tools
      : activeToolDeclarations(pi.getAllTools(), pi.getActiveTools())
    const toolDeclarationTokens = Math.ceil(
      estimateMessagesTokens(toolDeclarations) * pending.tokens.scale,
    )
    const providerOverhead = Math.max(0, tokensBefore - pending.tokens.nonSystemTotal)
    const otherProviderOverhead = Math.max(
      0,
      providerOverhead - systemPromptTokens - toolDeclarationTokens,
    )
    const totalNew = pending.tokens.preserved + checkpointSize + providerOverhead
    const covered = pending.scope.coveredUserMessages.length > 0
      ? pending.scope.coveredUserMessages.join(", ")
      : "(none)"
    metrics = [
      `context before: ${tokensBefore} tok`,
      `context after: ~${totalNew} tok`,
      `reclaimed: ~${reclaimed} tok`,
      "",
      `preserved dialogue: ${pending.tokens.preservedDialogue} tok`,
      ` user messages: ~${pending.tokens.preservedUserMessages} tok`,
      ` assistant text: ~${pending.tokens.preservedAssistantText} tok`,
      `historical checkpoints: ${pending.tokens.historicalCheckpoints} tok (${pending.tokens.checkpointCount})`,
      `new raw compactable: ${pending.tokens.newRawCompactable} tok`,
      ` tool calls: ~${pending.tokens.rawToolCalls} tok`,
      ` tool results: ~${pending.tokens.rawToolResults} tok`,
      ` reasoning: ~${pending.tokens.rawReasoning} tok`,
      ` other: ~${pending.tokens.rawOther} tok`,
      `new checkpoint #${pending.scope.nextCheckpointNumber}: ${checkpointSize} tok`,
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
  // every live request so user prompts and visible assistant prose remain
  // verbatim while tool history stays compacted and old reasoning stays discarded.
  pi.on("context", (event, ctx) => {
  const options = optionsFor(ctx)
  const model = ctx.model
  if (
  options.enabled === false ||
  options.preserveDialogue !== true ||
  !model ||
  !isModelAllowed(options.models, model.provider, model.id)
  ) return undefined
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

  // Preserve-mode pressure is handled at a tool-bearing turn boundary: by
  // turn_end every tool result from that turn is persisted, while the next
  // provider request has not started yet. Trigger at the earlier of the preserve
  // 90% budget and Pi's own threshold, then write context edits plus a hidden
  // checkpoint through the boundary API. Calling ctx.compact() here would abort
  // the active agent run and a real compaction entry would clear Pi's TUI history.
  pi.on("turn_end", async (event, ctx) => {
    const options = optionsFor(ctx)
    const model = ctx.model
    if (
      options.enabled === false ||
      options.preserveDialogue !== true ||
      !model ||
      !isModelAllowed(options.models, model.provider, model.id) ||
      event.toolResults.length === 0 ||
      event.entries.some((entry) => entry.type === "compaction")
    ) {
      return
    }

    const usage = ctx.getContextUsage()
    if (!usage || usage.tokens === null || usage.contextWindow <= 0) return

    const sessionId = ctx.sessionManager.getSessionId()
    if (dynamicCompactions.has(sessionId)) return

    const log = loggerFor(options)
    let triggerBranch: CompactionBranch = "normal (dynamic 90%)"
    try {
    const branchEntries = ctx.sessionManager.getBranch() as SessionEntry[]
      const tokens = compactionMessageTokens(ctx, branchEntries)
      // If the latest preserve checkpoint already owns all compactable state,
      // another compaction cannot reclaim anything. In particular, visible-only
      // assistant turns after a checkpoint must not cause a compaction loop merely
      // because fixed system/tool overhead keeps pressure above the threshold.
      if (tokens.newRawCompactable <= 0) return
      const preservedTokens = tokens.preserved
      const summarizer = resolveSummarizer(ctx, options, model)
      const piSettings = piCompactionSettings(ctx, model)
      const summaryLimit = summaryOutputCap({
      configured: options.summaryMaxTokens,
      reserveTokens: piSettings.reserveTokens,
      modelMaxTokens: summarizer.maxTokens,
      droppedTokens: tokens.compactable,
      })
      const headroomTokens = summaryLimit + PRESERVE_DYNAMIC_HEADROOM_MARGIN_TOKENS
      const budget = preserveCompactionBudget({
      contextTokens: usage.tokens,
      contextWindow: usage.contextWindow,
      preservedTokens,
      headroomTokens,
      })
      const piThresholdTokens = Math.max(0, usage.contextWindow - piSettings.reserveTokens)
      const beforePiThreshold = piSettings.enabled && usage.tokens >= piThresholdTokens
      triggerBranch = budget.shouldCompact
      ? "normal (dynamic 90%)"
      : "normal (before Pi threshold)"

      log.record("dynamic_compaction_pressure", {
        sessionId,
        boundary: "turn_end",
        contextTokens: usage.tokens,
        contextWindow: usage.contextWindow,
        preservedTokens: budget.preservedTokens,
        availableTokens: budget.availableTokens,
        occupiedTokens: budget.occupiedTokens,
        thresholdTokens: budget.thresholdTokens,
        pressure: budget.pressure,
        headroomTokens,
        newRawCompactableTokens: tokens.newRawCompactable,
        piReserveTokens: piSettings.reserveTokens,
        piThresholdTokens,
        beforePiThreshold,
        trigger: budget.shouldCompact || beforePiThreshold,
        })
        if (!budget.shouldCompact && !beforePiThreshold) return

        dynamicCompactions.set(sessionId, triggerBranch)
        log.both("dynamic preserve compaction triggered at turn boundary", {
        sessionId,
        contextTokens: usage.tokens,
        contextWindow: usage.contextWindow,
        preservedTokens: budget.preservedTokens,
        pressure: budget.pressure,
      })

      // Historical checkpoints remain immutable request context; the new summary is delta-only.
      const syntheticEvent = {
        type: "session_before_compact",
        preparation: {
          firstKeptEntryId: event.messageEntryId,
          tokensBefore: usage.tokens,
          messagesToSummarize: [],
          turnPrefixMessages: [],
          // Do not pass previousSummary: preserve mode never rewrites an old checkpoint.
          fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
          settings: piSettings,
        },
        branchEntries,
        customInstructions: undefined,
        reason: "manual",
        willRetry: false,
        signal: ctx.signal ?? new AbortController().signal,
      } as unknown as SessionBeforeCompactEvent

      const result = await handleCompaction(syntheticEvent, ctx)
      if (!result?.compaction) {
        reportCompactionFailure(ctx, triggerBranch, true)
        log.record("dynamic_compaction_complete", { sessionId, cancelled: true })
        return
      }

      reportCompactionComplete(
      ctx,
      triggerBranch,
      result.compaction.summary,
      usage.tokens,
      )
      log.record("dynamic_compaction_complete", { sessionId, cancelled: false })

      const checkpointEntries = preserveDialogueBoundaryEntries({
      branchEntries,
      summary: result.compaction.summary,
      tokensBefore: usage.tokens,
      details: result.compaction.details as CacheCompactDetails,
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

  pi.on("session_compact", (event, ctx) => {
  const options = optionsFor(ctx)
  const model = ctx.model
  if (
  options.enabled === false ||
  options.preserveDialogue !== true ||
  !model ||
  !isModelAllowed(options.models, model.provider, model.id)
  ) return
  reportCompactionComplete(
      ctx,
      compactionBranch(event.reason, dynamicCompactions.get(ctx.sessionManager.getSessionId())),
      event.compactionEntry.summary,
      event.compactionEntry.tokensBefore,
    )
  })

  pi.on("session_compact_failed", (event, ctx) => {
  const options = optionsFor(ctx)
  const model = ctx.model
  if (
  options.enabled === false ||
  options.preserveDialogue !== true ||
  !model ||
  !isModelAllowed(options.models, model.provider, model.id)
  ) return
  reportCompactionFailure(
      ctx,
      compactionBranch(event.reason, dynamicCompactions.get(ctx.sessionManager.getSessionId())),
      event.aborted,
      event.errorMessage,
    )
  })

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
      messages: snapshot(afterMessages),
      tools: snapshot(Array.isArray(after.tools) ? after.tools : []),
      },
      })
      }
      if (options.debugPayloads === true && dumpNextLive.delete(sessionId)) {
      loggerFor(options).record("payload_dump", { sessionId, variant: "live_after", payload })
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
    if (options.preserveDialogue === true && event.reason === "threshold") {
    const tokens = compactionMessageTokens(ctx, event.branchEntries as SessionEntry[])
    if (tokens.newRawCompactable <= 0) {
    log.record("native_threshold_cancelled_no_new_compactable_state", {
    sessionId,
    tokensBefore: event.preparation.tokensBefore,
    historicalCheckpointTokens: tokens.historicalCheckpoints,
    })
    return { cancel: true }
    }
    }
    if (options.preserveDialogue === true) {
const branch = compactionBranch(event.reason, dynamicCompactions.get(sessionId))
try {
const tokens = compactionMessageTokens(ctx, event.branchEntries as SessionEntry[])
const usage = ctx.getContextUsage()
const contextTokens =
usage?.tokens === null || usage === undefined ? undefined : usage.tokens
pendingCompactionUi.set(sessionId, {
branch,
tokens,
scope: preserveDeltaScope(event.branchEntries as SessionEntry[]),
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

// Preserve mode has a stronger semantic boundary than Pi's native cut:
// every tool interaction that exists *now* must be absorbed into the
// technical checkpoint. Pi's firstKeptEntryId / keepRecentTokens may still
// describe how its raw projection is persisted, but they do not define the
// model-visible preservation boundary.
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
const preserveDeltaAgent = preserveDialogueDeltaMessages(event.branchEntries as SessionEntry[])
const preserveScope = options.preserveDialogue === true
? preserveDeltaScope(event.branchEntries as SessionEntry[])
: undefined
const summaryScopeAgent =
options.preserveDialogue === true ? preserveDeltaAgent : nativeDroppedAgent
const liveMessages = convertToLlm(effectiveAgent)
const observedCount = liveRequestCounts.get(sessionId)
const requestMessages =
observedCount !== undefined && observedCount > 0 && observedCount < liveMessages.length
? liveMessages.slice(0, observedCount)
: liveMessages
const plan = planSummaryRequest({
liveMessages,
requestMessages,
droppedMessages: convertToLlm(summaryScopeAgent),
keptCount:
options.preserveDialogue === true
? 0
: projection.messages.length - nativeDroppedAgent.length,
// In preserve mode there is no retained pre-compaction turn suffix in
// the rebuilt model view: all old tool traffic is summarized and all old
// dialogue is restored independently.
turnPrefixCount:
options.preserveDialogue === true
? 0
: event.preparation.turnPrefixMessages?.length ?? 0,
...(options.preserveDialogue !== true && event.preparation.previousSummary
? { previousSummary: event.preparation.previousSummary }
: undefined),
options,
customInstructions: event.customInstructions,
preserveUserMessageOrdinals: preserveScope?.coveredUserMessages,
contextWindow: (summarizer as { contextWindow?: number }).contextWindow,
reserveTokens: event.preparation.settings?.reserveTokens,
modelMaxTokens: (summarizer as { maxTokens?: number }).maxTokens,
summaryMaxTokens: options.summaryMaxTokens,
...(options.preserveDialogue === true
? { reclaimedTokens: compactionMessageTokens(ctx, event.branchEntries as SessionEntry[]).newRawCompactable }
: undefined),
})
// Preserve mode must absorb every tool interaction that exists at this
    // compaction. If the complete tool-state request no longer fits, a native
    // Pi cut or partial rewind would leave some tool traffic raw, violating the
    // mode's contract, so fail closed before sending a doomed request.
    if (options.preserveDialogue === true && !plan.requestFits) {
      return preserveFallback("full preserve tool-state summary no longer fits", {
        sessionId,
        tokensBefore: event.preparation.tokensBefore,
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
    const askHash = shortHash(plan.ask)

    // Effort for the summary ask: explicit config, else whatever the last
    // live request of this session actually sent — the cached prefix is keyed
    // by the sent value, so a mid-session /thinking change makes the live
    // request itself re-prefill, but our ask still matches the newest prefix.
    const reasoningEffort = resolveSummaryReasoningEffort(
      options.summaryReasoningEffort,
      liveEfforts.get(sessionId),
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
          // The comparison pair: the last live request before compaction and
          // our summarization request, byte for byte. `scripts/compare-dumps.mjs`
          // diffs them and prints the first differing message.
          const lastLive = [...recentLivePayloads].reverse().find((entry) => entry.sessionId === sessionId)
          if (lastLive) {
            log.record("payload_dump", { sessionId, variant: "live_before", payload: lastLive.payload })
          }
          log.record("payload_dump", {
            sessionId,
            variant: "summarization",
            systemSource: info.hasLeadingSystemMessage ? "recorded" : "synthesized",
            requestShape: info.requestShape,
            payload: snapshot(payload),
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
        toolChoice: options.toolChoice ?? "none",
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
      pendingAskHashes.add(askHash)
      const startedAt = Date.now()
      let response: AssistantMessage
      try {
        response = await generateSummary(pi, ctx, event, options, summarizer, reasoningEffort, plan, recordSummaryPayload, requestHeaders)
      } finally {
        // The ask is deterministic, so its hash is known up front; the
        // returned `ask` is only used for that hash, which we already have.
        pendingAskHashes.delete(askHash)
      }
      const durationMs = Date.now() - startedAt
      let rejection = summaryRejection(response)
// Empty or tool-call-only replies get one deterministic retry. Cache usage is
// diagnostic only and never changes retry or checkpoint semantics.
if (rejection === NO_TEXT_REPLY || rejection === TOOL_CALL_TEXT_REPLY) {
        log.both("summary reply was unusable; retrying once", {
          reason: rejection,
          sessionId,
          stopReason: response.stopReason,
          usage: response.usage,
          blocks: describeContent(response.content, options.debugPayloads === true),
        })
        const retryPlan: SummaryRequestPlan = {
          ...plan,
          // The retry keeps the cached prefix (the nudge goes after the ask) and
          // is concrete on purpose: a reply that stops inside the reasoning
          // channel is best discouraged by naming exactly what the visible
          // answer should start with, not by asking the model to "write text".
          ask: `${plan.ask}\n\nReminder: reply with the summary text itself. Do not call any tools, do not write tool-call syntax, do not leave the summary in your reasoning, and do not end your turn before writing it — start with the summary's first heading.`,
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
            retryPlan,
            recordSummaryPayload,
            requestHeaders,
          )
          rejection = summaryRejection(response)
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
    const summary = extractSummaryText(response.content) + formatFileOperations(readFiles, modifiedFiles)
    const details: CacheCompactDetails = {
    readFiles,
    modifiedFiles,
    ...(options.preserveDialogue === true
    ? { cacheCompact: PRESERVE_DIALOGUE_MARKER }
    : undefined),
    }
// Cache usage remains available in summary_result diagnostics below.

    if (options.preserveDialogue === true) {
    const branchEntries = event.branchEntries as SessionEntry[]
    const scope = preserveDeltaScope(branchEntries)
    const tokens = compactionMessageTokens(ctx, branchEntries)
    const preview = previewPreservedContextAfterCheckpoint({
    branchEntries,
    summary,
    tokensBefore: event.preparation.tokensBefore,
    details,
    })
    let systemCount = 0
    while (effectiveAgent[systemCount]?.role === "system") systemCount += 1
    const afterAgent = [...effectiveAgent.slice(0, systemCount), ...preview]
    const afterMessages = convertToLlm(afterAgent)
    const afterNonSystem = afterMessages.filter((message) => message.role !== "system")
    const estimatedAfterNonSystem = Math.ceil(estimateMessagesTokens(afterNonSystem) * tokens.scale)
    const newCheckpointMessages = preview.slice(-1)
    const newCheckpointTokens = Math.ceil(
    estimateMessagesTokens(convertToLlm(newCheckpointMessages)) * tokens.scale,
    )
    const reclaimed = Math.max(0, tokens.newRawCompactable - newCheckpointTokens)
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
    const divergenceBefore = firstDivergenceMessage === null ? undefined : beforeStructural[firstDivergenceMessage]
    const divergenceAfter = firstDivergenceMessage === null ? undefined : afterMessages[firstDivergenceMessage]
    const lastLive = [...recentLivePayloads].reverse().find((entry) => entry.sessionId === sessionId)
    const lastLiveRecord = (lastLive?.payload ?? {}) as { tools?: unknown }
    const toolDeclarations = Array.isArray(lastLiveRecord.tools) ? lastLiveRecord.tools : []
    const systemPromptTokens = Math.ceil(
      estimateMessagesTokens(beforeStructural.filter((message) => message.role === "system")) * tokens.scale,
    )
    const toolDeclarationTokens = Math.ceil(
      estimateMessagesTokens(toolDeclarations) * tokens.scale,
    )
    const providerOverhead = Math.max(0, event.preparation.tokensBefore - tokens.nonSystemTotal)
    const otherProviderOverhead = Math.max(
      0,
      providerOverhead - systemPromptTokens - toolDeclarationTokens,
    )
    const estimatedAfter = estimatedAfterNonSystem + providerOverhead

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
    toolDeclarations: snapshot(toolDeclarations),
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
    rawToolCalls: tokens.rawToolCalls,
    rawToolResults: tokens.rawToolResults,
    rawReasoning: tokens.rawReasoning,
    rawOther: tokens.rawOther,
    newCheckpoint: newCheckpointTokens,
    remainingRawCompactable: 0,
    estimatedContextAfter: estimatedAfter,
    estimatedReclaimed: reclaimed,
    compression: newCheckpointTokens > 0 ? tokens.newRawCompactable / newCheckpointTokens : null,
    },
    cachePrefixPreview: {
    stableMessages: stablePrefixMessages,
    stableEstimatedTokens: stablePrefixTokens,
    firstDivergenceMessage,
    firstDivergence: firstDivergenceMessage === null
    ? null
    : {
    index: firstDivergenceMessage,
    reason: "preserve compaction removed or changed raw technical state at this message",
    beforeRole: (divergenceBefore as { role?: unknown } | undefined)?.role,
    beforeKind: debugMessageKind(divergenceBefore),
    beforeHash: shortHash(divergenceBefore),
    afterRole: (divergenceAfter as { role?: unknown } | undefined)?.role,
    afterKind: debugMessageKind(divergenceAfter),
    afterHash: shortHash(divergenceAfter),
    },
    },
    contextBefore: snapshot(beforeStructural),
    contextAfter: snapshot(afterMessages),
    contextIndex: {
    before: debugContextIndex(beforeStructural, tokens.scale, branchEntries),
    after: debugContextIndex(afterMessages, tokens.scale, branchEntries, { number: scope.nextCheckpointNumber, summary }),
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
    }

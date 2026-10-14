/**
 * Pure, dependency-light helpers for pi-cache-compact.
 *
 * Kept free of runtime SDK imports so the unit tests can exercise the real
 * logic without booting Pi. Everything imported here is a type and is erased
 * when Node strips types.
 */

import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai"
import type { ToolInfo } from "@earendil-works/pi-coding-agent"

/**
 * Pi's compaction prompts, copied verbatim from
 * `@earendil-works/pi-coding-agent` `dist/core/compaction/compaction.js` (v0.87.0),
 * so the summary persisted here is the artifact Pi's own compaction would have
 * written. The package does not export them, hence the copy: if Pi changes its
 * summary format, copy the new text over.
 *
 * The deliberate deviations from Pi live elsewhere — in what the model gets to
 * read (the real messages, never a truncated serialization) and in how the
 * request is shaped (a continuation of the live conversation, so a
 * prefix-caching server serves it from cache).
 */
export const PI_SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

export const PI_UPDATE_SUMMARY_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`

export const PI_TURN_PREFIX_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`

/**
 * The format half of Pi's turn-prefix prompt, embedded in our single-request
 * ask. Pi sends the whole text as the instruction of a *separate* call, so with
 * him there is nothing to echo; with both parts asked for in one reply, a model
 * handed prose instructions inline copies them into the artifact (observed:
 * "This is the PREFIX of a turn that was too large to keep." landed in the
 * persisted summary). A test asserts these lines still match Pi's prompt, so
 * drift shows up as a failure rather than a quiet artifact change.
 */
export const PI_TURN_PREFIX_FORMAT = `## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]`

/** Pi's heading for the retained part of a split turn, and its empty-history text. */
export const PI_SPLIT_MARKER = "**Turn Context (split turn):**"
export const PI_NO_HISTORY = "No prior history."

export const PRESERVE_TOOL_SUMMARY_PROMPT = `Create a NEW compact incremental technical checkpoint ONLY from tool activity, tool results, and tool-derived operational state that occurred after the most recent Tool Context Checkpoint in this conversation. If no prior checkpoint exists, cover tool activity from the start of the conversation.

Historical Tool Context Checkpoints are immutable preserved context. Do NOT repeat, merge, rewrite, update, summarize, or supersede them.

The original user messages and completed assistant responses are preserved verbatim elsewhere and remain in the model context. Do NOT summarize, paraphrase, restate, reinterpret, or quote them.

The final user-role message containing this checkpoint instruction is synthetic cache-compact control text, not a historical user message. Do NOT count it when assigning user-message ordinals, quote or summarize it, or create a "### User message N" section for it.

Assistant thinking/reasoning is intentionally discarded. Do NOT preserve it or promote claims that appear only in thinking. Include a fact only when it is evidenced by tool activity/results or by repository/runtime state observed through tools.

Associate every tool-derived fact with the most recent preceding user message that caused that work. The responsible user message may appear before the most recent checkpoint when the same tool loop continues across checkpoints. Label sections as \"User message N\", where N is that message's absolute order among user-role messages from the start of the conversation. Do not restate the user prompt.

Summarize RESULTS, findings, produced state, and validation evidence — not a history of tool calls. A statement such as \"Read src/foo.ts\", \"searched for X\", or \"ran tests\" is insufficient unless the action itself is operationally important. Prefer the resulting fact or evidence.

Examples:
- weak: \"Read src/foo.ts.\"
- strong: \"src/foo.ts routes retries through RetryPolicy.nextDelay; no separate retry loop was found.\"
- weak: \"Ran cargo test.\"
- strong: \"cargo test -p targets: 214 passed, 5 ignored, 0 failed.\"

For each user message that has scoped tool activity, use this format:

## Tool Context
### User message N
#### Findings
- [tool-evidenced results and durable facts, or \"(none)\"]

#### Changes & Validation
- [changes actually made plus observed validation/evidence, or \"(none)\"]

#### Unresolved
- [open tool-evidenced findings/blockers, or \"(none)\"]

Omit user messages with no scoped tool activity. Keep exact file paths, identifiers, commands, counts, output values, and error text when they materially support a result. Keep the checkpoint compact and factual.`

export type SummaryPromptOptions = {
  /** Replace the default handoff instruction. */
  summaryPrompt?: string
  /** Summarize only tool-derived state; dialogue is restored verbatim and reasoning is discarded. */
  preserveDialogue?: boolean
}

/**
 * Where the summary should stop, when the request also contains messages that
 * stay in the context.
 *
 * Appending the ask to the live conversation is what keeps the request a
 * forward continuation (see `continuation` in config.ts) — but Pi still keeps
 * the recent tail verbatim, so a summary that covers it too would describe
 * those messages twice. The boundary is named in the ask so the model can leave
 * the tail out while the *request* stays cache-friendly.
 */
export type SummaryBoundary = {
  /** Messages after the boundary that remain in the context verbatim. */
  keptCount: number
  /** Role of the last message the summary should cover. */
  role: string
  /** Opening words of that message, so the model can locate it exactly. */
  snippet: string
}

export type SummaryAskArgs = SummaryPromptOptions & {
  /** The request also carries a previous summary: use Pi's update prompt. */
  previous?: boolean
  /** What the summary covers, when later messages stay in the context. */
  boundary?: SummaryBoundary
  /**
   * A split turn: the dropped span contains the start of a turn whose end is
   * retained, so Pi's artifact has a second section under
   * `**Turn Context (split turn):**`. `hasHistory` is false when there was
   * nothing before the turn, which Pi renders as "No prior history.".
   */
  split?: { boundary: SummaryBoundary; hasHistory: boolean }
  /** Extra focus from the caller (`customInstructions`). */
  focus?: string
  /** Absolute user-message ordinals that own tool activity in this preserve delta. */
  preserveUserMessageOrdinals?: readonly number[]
}

/**
 * Compose the user turn that asks for the summary.
 *
 * The base text is Pi's own (`summaryPrompt` overrides it), and for a split
 * turn the ask describes both parts Pi would write, in Pi's order and with
 * Pi's headings — so the persisted artifact matches Pi's format whether or not
 * this extension produced it. Only the *scope* notes are ours: the request is a
 * continuation, so it also contains messages that stay in the context and the
 * model has to be told where to stop.
 */
export function renderSummaryAsk(args: SummaryAskArgs = {}): string {
  const base =
    args.summaryPrompt?.trim() ||
    (args.preserveDialogue
      ? PRESERVE_TOOL_SUMMARY_PROMPT
      : args.previous
        ? PI_UPDATE_SUMMARY_PROMPT
        : PI_SUMMARY_PROMPT)
  const parts = [
    base,
    // Pi's prompt does not say this (Pi declares no tools at all, so its model
    // cannot be tempted). This extension must keep the tools declared for the
    // cache, and a model that answers by *acting* — or by writing tool-call
    // syntax as text, which the provider reports as an ordinary text block —
    // would otherwise have that text persisted as the conversation prefix.
    "Do not call any tools. Reply with the summary itself, never with a tool call.",
  ]
  const focus = args.focus?.trim()
  if (focus) parts.push(`Additional focus: ${focus}`)
  if (args.preserveDialogue && args.preserveUserMessageOrdinals?.length) {
    parts.push(
      `This checkpoint contains new tool activity for absolute user-message ordinal(s): ${args.preserveUserMessageOrdinals.join(", ")}. Use ONLY these exact ordinals in the "### User message N" headings and do not create any other user-message heading. If tool activity continues a user turn that began before the latest checkpoint, its original user message may be outside the new delta; keep using the listed absolute ordinal instead of renumbering from the visible delta.`,
    )
  }
  const scope = (boundary: SummaryBoundary, closing: string): string =>
    `Cover the conversation only up to and including the ${boundary.role} message that begins:\n\n"${boundary.snippet}"\n\n${closing}`

  if (args.split && !args.preserveDialogue) {
    if (args.boundary) {
      parts.push(scope(args.boundary, "Do not cover anything after that point here."))
    }
    if (!args.split.hasHistory) {
      parts.push(
        `If there is nothing to summarize before the turn below, reply with exactly "${PI_NO_HISTORY}" instead of the format above.`,
      )
    }
    parts.push(
      [
        `Then, on a new line, write exactly --- and on the line after it exactly "${PI_SPLIT_MARKER}", followed by a summary of the part of the turn that was too large to keep.`,
        "Use these headings and replace each bracketed placeholder with real content; do not repeat any of these instructions:",
        PI_TURN_PREFIX_FORMAT,
      ].join("\n\n"),
    )
    parts.push(
      scope(
        args.split.boundary,
        `${args.split.boundary.keptCount} later message(s) stay in the context verbatim as the retained suffix, and must NOT be covered by either part of the summary.`,
      ),
    )
    return parts.join("\n\n")
  }

  if (args.boundary) {
    parts.push(
      scope(
        args.boundary,
        `The conversation does not end here: ${args.boundary.keptCount} later message(s) stay in the context verbatim and must NOT be covered by this summary.`,
      ),
    )
  }
  return parts.join("\n\n")
}

/**
 * First `limit` characters of a message's visible text, whitespace collapsed —
 * enough for a model to locate the message in its own context.
 */
const DEFAULT_PRESERVE_RESERVE_TOKENS = 16_384

/**
 * Context-scaled reserve owned by preserve mode.
 *
 * This fitted curve is the single preserve-mode threshold policy. A checkpoint
 * starts when the projected next context enters the final reserveTokens.
 */
export function preserveReserveTokens(contextWindow: number | undefined): number {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return DEFAULT_PRESERVE_RESERVE_TOKENS
  }
  const window = Math.floor(contextWindow)
  const fitted = Math.round(
    88_319.65 + (1_468.926 - 88_319.65) / (1 + Math.pow(window / 1_413_076, 0.7096055)),
  )
  return Math.min(window, Math.max(1, fitted))
}

// reserveTokens is the only preserve-mode compaction threshold.
export type SummaryRequestShape =
| "continuation"
| "continuation-request"
| "dropped"
| "delta-only"

export const PRESERVE_DELTA_ONLY_SYSTEM_PROMPT =
"Summarize the supplied technical context. Follow the final user instruction exactly."

// No independent automatic-summary minimum: reserveTokens is the policy.

export type SummaryRequestPlan = {
  /** Messages the request sends, ask excluded. */
  messages: Message[]
  /** What compaction drops — what the summary text should cover. */
  droppedMessages: Message[]
  /** The appended user turn, scope notes and split-turn structure included. */
  ask: string
  /** Which shape was chosen (see `SummaryRequestShape`). */
  shape: SummaryRequestShape
  /**
   * True when the chosen shape is the rewind because no continuation fitted —
   * as opposed to `continuation: false`, where the caller asked for it. A
   * rewind never hit a cache in any measurement and costs a whole cold
   * prefill, so the caller may prefer Pi's own small summary instead.
   */
  rewindFallback: boolean
  /** Whether the chosen messages + ask + output budget fit the model window. */
  requestFits: boolean
  /** Output ceiling for this request, resolved by `summaryOutputCap`. */
  maxTokens: number
  boundary?: SummaryBoundary
  /** Present for a split turn: the ask carries both parts Pi would write. */
  split?: { boundary: SummaryBoundary; hasHistory: boolean }
}

/**
 * Decide the summarization request in one place, so the ask hash the
 * `before_provider_request` fallback matches is the ask that is actually sent.
 *
 * Four shapes, ordered by cache reuse and mode:
 *
 * 1. `continuation` — the whole projection. Extends the checkpoint the server
 * holds *including* the reply it generated, so it is the safest bet for
 * cache reuse, and the largest: a big tool result appended after the last
 * request can push it past the context window on its own.
 * 2. `continuation-request` — the messages of the last live request. The server
 * evaluated exactly these tokens, so appending the ask is still a strict
 * forward continuation, without the (possibly huge) messages that arrived
 * after it.
 * 3. `delta-only` — preserve-mode safety path containing only the compactable
 * technical delta plus a tiny system instruction and the checkpoint ask. It is
 * cold by design and is used only when a cache-friendly preserve request cannot
 * fit safely or when a cached summary itself exhausts its output budget.
 * 4. `dropped` — legacy non-preserve rewind over Pi's dropped span. It is used
 * when `continuation: false` or when legacy rewind fallback is enabled.
 *
 * The first eligible shape that fits wins. Preserve mode prefers cache-friendly
 * continuation shapes and then delta-only; non-preserve mode keeps the legacy
 * continuation/dropped behavior.
 *
 * Messages arrive already converted because `convertToLlm` is a runtime import
 * and this module stays pure (type-only SDK imports).
 */
export function planSummaryRequest(args: {
  /** The full projection: every message the conversation currently has. */
  liveMessages: Message[]
  /** The messages of the previous live provider request (a prefix of the above). */
  requestMessages: Message[]
  /** Exact server-reported prompt tokens for requestMessages, when available. */
  requestPromptTokens?: number
  droppedMessages: Message[]
  /** Messages that stay in the context verbatim after the boundary. */
  keptCount?: number
  /**
   * How many messages at the end of the dropped span belong to the current,
   * still-open turn (Pi's `turnPrefixMessages`). Non-zero makes this a split
   * turn: Pi writes the retained part under a `**Turn Context (split turn):**`
   * heading, and the ask has to describe both parts.
   */
  turnPrefixCount?: number
  /** A previous summary is part of the request: use Pi's update prompt. */
  previousSummary?: string
  options: SummaryPromptOptions & { continuation?: boolean }
  customInstructions?: string
  contextWindow?: number
  /** Legacy non-preserve output cap. Preserve mode ignores it. */
  maxTokens?: number
  reserveTokens?: number
  modelMaxTokens?: number
  /** Absolute user-message ordinals covered by this preserve delta. */
  preserveUserMessageOrdinals?: readonly number[]
  /** Prefer a delta-only request after a cache-friendly summary exhausts its output budget. */
  preferDeltaOnly?: boolean
  }): SummaryRequestPlan {
  // Resolve the output ceiling once from the active mode's policy so every fit
  // check and the actual request use the same ceiling.
  // Reported usage calibrates historical content, but it cannot prove that a new
  // tool blob tokenizes as cheaply as that prefix. Never scale unreported bytes
  // below the conservative bytes/3 baseline.
  const scale = unreportedTokenScale(args.liveMessages)
  const reserveMaxTokens = summaryOutputCap({
    reserveTokens: args.reserveTokens,
    modelMaxTokens: args.modelMaxTokens,
    preserveDialogue: args.options.preserveDialogue,
  })
  const maxTokens =
    args.options.preserveDialogue === true
      ? reserveMaxTokens
      : Math.max(1, Math.min(reserveMaxTokens, args.maxTokens ?? Number.POSITIVE_INFINITY))
  const fitAsk = renderSummaryAsk({
    summaryPrompt: args.options.summaryPrompt,
    preserveDialogue: args.options.preserveDialogue,
    previous: Boolean(args.previousSummary),
    focus: args.customInstructions,
    preserveUserMessageOrdinals: args.preserveUserMessageOrdinals,
  })
  const preserveMinimumOutput = 1
  type SummaryCandidate = {
  shape: SummaryRequestShape
  messages: Message[]
  reportedPrefixTokens?: number
  }
  const outputBudget = (candidate: SummaryCandidate): number | undefined => {
    const deltaOnly = candidate.shape === "delta-only"
    return continuationOutputBudget({
      contextWindow: args.contextWindow,
      messages: candidate.messages,
      // A delta-only summary is a brand-new prompt. Historical provider calibration
      // describes a different, much larger prefix and must not inflate this delta.
      scale: deltaOnly ? 1 : scale,
      ask: fitAsk,
      ignoreReportedUsage: deltaOnly,
      ...(candidate.reportedPrefixTokens === undefined
        ? {}
        : { reportedPrefixTokens: candidate.reportedPrefixTokens }),
    })
  }
  const fits = (candidate: SummaryCandidate): boolean => {
    if (args.options.preserveDialogue === true) {
      const budget = outputBudget(candidate)
      return budget === undefined || budget >= preserveMinimumOutput
    }
    return continuationFits({
      contextWindow: args.contextWindow,
      maxTokens,
      messages: candidate.messages,
      scale,
      ask: fitAsk,
    })
  }

  const droppedCount = args.droppedMessages.length
  const keptCount = args.keptCount ?? args.liveMessages.length - droppedCount
  // The last live provider request is usable only if its prefix reaches the
  // actual compacted boundary in the model-visible context. Comparing only
  // with `droppedCount` is insufficient when preserveDialogue has restored
  // older dialogue before Pi's native projected prefix.
  const requiredRequestCount = Math.max(0, args.liveMessages.length - keptCount)
  const candidates: SummaryCandidate[] = []
  if (args.options.preserveDialogue === true) {
    const usePreviousProviderPrefix =
      args.requestMessages.length >= requiredRequestCount &&
      args.requestMessages.length > 0 &&
      args.requestMessages.length < args.liveMessages.length
    const continuationCandidate: SummaryCandidate = {
      shape: usePreviousProviderPrefix ? "continuation-request" : "continuation",
      messages: usePreviousProviderPrefix ? args.requestMessages : args.liveMessages,
      ...(usePreviousProviderPrefix && args.requestPromptTokens !== undefined
        ? { reportedPrefixTokens: args.requestPromptTokens }
        : {}),
    }
    const deltaOnlyCandidate: SummaryCandidate = {
      shape: "delta-only",
      messages: [
        {
          role: "system",
          content: PRESERVE_DELTA_ONLY_SYSTEM_PROMPT,
          timestamp: 0,
        } as Message,
        ...args.droppedMessages,
      ],
    }
    if (args.preferDeltaOnly === true) {
      candidates.push(deltaOnlyCandidate)
    } else {
      candidates.push(continuationCandidate, deltaOnlyCandidate)
    }
  } else {
    if (args.options.continuation !== false) {
      if (args.liveMessages.length > droppedCount) {
        candidates.push({ shape: "continuation", messages: args.liveMessages })
      }
      if (args.requestMessages.length >= requiredRequestCount && args.requestMessages.length > 0) {
        candidates.push({ shape: "continuation-request", messages: args.requestMessages })
      }
    }
    candidates.push({ shape: "dropped", messages: args.droppedMessages })
  }

  const chosen =
    candidates.find((candidate) => candidate.shape !== "dropped" && fits(candidate)) ??
    candidates.find((candidate) => fits(candidate)) ??
    candidates[0]
  const rewindFallback =
    args.options.preserveDialogue !== true &&
    chosen.shape === "dropped" &&
    args.options.continuation !== false
  let requestFits = fits(chosen)
  let requestMaxTokens = maxTokens
  if (args.options.preserveDialogue === true) {
    const budget = outputBudget(chosen)
    requestFits = budget === undefined || budget >= preserveMinimumOutput
    if (requestFits && budget !== undefined) {
      requestMaxTokens = Math.max(1, Math.min(maxTokens, Math.floor(budget)))
    }
  }

  const boundaryFor = (messages: readonly unknown[]): SummaryBoundary | undefined => {
    const last = messages[messages.length - 1]
    if (!last) return undefined
    const snippet = messageSnippet((last as { content?: unknown }).content)
    if (!snippet) return undefined
    return {
      keptCount: args.keptCount ?? chosen.messages.length - droppedCount,
      role: String((last as { role?: unknown }).role ?? "user"),
      snippet,
    }
  }

  // The scope note only matters when the request also carries messages the
  // model may not summarize: nothing is retained when the shape is `dropped`
  // (a rewind) or when the conversation kept no tail at all.
  const boundary =
    args.options.preserveDialogue === true
      ? undefined
      : chosen.shape !== "dropped" && keptCount > 0
        ? boundaryFor(args.droppedMessages)
        : undefined

  let split: SummaryRequestPlan["split"]
  const turnPrefixCount = args.turnPrefixCount ?? 0
  if (turnPrefixCount > 0 && turnPrefixCount <= droppedCount) {
    const history = args.droppedMessages.slice(0, droppedCount - turnPrefixCount)
    const prefixBoundary = boundaryFor(args.droppedMessages)
    if (prefixBoundary && args.options.preserveDialogue !== true) {
      split = {
        boundary: prefixBoundary,
        hasHistory: history.length > 0 || Boolean(args.previousSummary),
      }
    }
  }

  return {
    messages: chosen.messages,
    droppedMessages: args.droppedMessages,
    maxTokens: requestMaxTokens,
    rewindFallback,
    requestFits,
    ask: renderSummaryAsk({
      summaryPrompt: args.options.summaryPrompt,
      preserveDialogue: args.options.preserveDialogue,
      previous: Boolean(args.previousSummary),
      focus: args.customInstructions,
      preserveUserMessageOrdinals: args.preserveUserMessageOrdinals,
      ...(boundary ? { boundary } : undefined),
      ...(split ? { split } : undefined),
    }),
    shape: chosen.shape,
    ...(boundary ? { boundary } : undefined),
    ...(split ? { split } : undefined),
  }
}

export function messageSnippet(content: unknown, limit = 160): string {
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: content }]
  const text = blocks
    .map((block) => {
      if (typeof block === "string") return block
      const record = block as { type?: unknown; text?: unknown }
      return record?.type === "text" && typeof record.text === "string" ? record.text : ""
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Keep only the tools that are active, in the order Pi reports them, and
 * project them to the provider-facing declaration. The order has to match the
 * live request or the prefix cache would miss.
 */
export function activeToolDeclarations(
  all: readonly ToolInfo[],
  activeNames: readonly string[],
): Tool[] {
  const byName = new Map(all.map((tool) => [tool.name, tool]))
  const declarations: Tool[] = []
  for (const name of activeNames) {
    const tool = byName.get(name)
    if (!tool) continue
    declarations.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })
  }
  return declarations
}

export type SummaryContext = {
  systemPrompt: string
  tools: Tool[]
  messages: Message[]
}

/**
 * Server-reported prompt size of the request that produced this message, when
 * the provider reported usage: the prompt is `input` (newly evaluated) plus
 * whatever came from the cache. This is the *server's* own token count — far
 * more trustworthy than any client-side estimate, which can be off by ~2x on
 * blob-heavy transcripts.
 */
export function promptTokensOf(message: unknown): number | undefined {
  if (typeof message !== "object" || message === null) return undefined
  const record = message as { role?: unknown; usage?: unknown }
  if (record.role !== "assistant" || typeof record.usage !== "object" || record.usage === null) {
    return undefined
  }
  const usage = record.usage as { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown }
  const parts = [usage.input, usage.cacheRead, usage.cacheWrite]
  if (!parts.some((part) => typeof part === "number" && Number.isFinite(part))) return undefined
  const total = parts.reduce<number>(
    (sum, part) => sum + (typeof part === "number" && Number.isFinite(part) ? part : 0),
    0,
  )
  // A zeroed usage record (aborted or legacy turns) is not a usable report: a
  // reply that exists had a prompt. Returning 0 would silently disable the
  // guard and let an oversized continuation through.
  return total > 0 ? total : undefined
}

/**
 * Bytes-per-token assumed for the part of a continuation that has no reported
 * usage (the trailing assistant turn and the ask). 3 is deliberately below the
 * ~4 chars/token of English prose: high-entropy content (base64, hashes, long
 * paths) tokenizes worse, and underestimating the prompt is what turns a
 * summary into a hard `exceed_context_size_error`.
 */
const BYTES_PER_TOKEN = 3
const UTF8_ENCODER = new TextEncoder()

function byteLength(value: unknown): number {
try {
const serialized = JSON.stringify(value)
return serialized === undefined ? 0 : UTF8_ENCODER.encode(serialized).byteLength
} catch {
return UTF8_ENCODER.encode(String(value)).byteLength
}
}

function estimatedTokens(value: unknown): number {
  return Math.ceil(byteLength(value) / BYTES_PER_TOKEN)
}

/**
 * How much the byte estimate over- or under-counts for this conversation.
 *
 * The reported prompt of a live request is exact, and we can estimate the same
 * messages ourselves, so their ratio calibrates every estimate we make on the
 * same conversation. `bytes / 3` is deliberately pessimistic and blob-heavy
 * transcripts came out ~3x high; a raw estimate that far off makes the fit
 * check refuse shapes that would have fit, and makes the compacted-state ceiling
 * inert. Clamped, because a bad ratio is worse than none: it is only ever a
 * correction to an estimate that has to stay in the same ballpark.
 */
export function tokenScale(messages: readonly unknown[]): number {
for (let index = messages.length - 1; index >= 0; index--) {
const reported = promptTokensOf(messages[index])
if (reported === undefined) continue
const estimated = estimateMessagesTokens(messages.slice(0, index))
if (estimated <= 0) continue
const ratio = reported / estimated
if (!Number.isFinite(ratio)) continue
return Math.min(5, Math.max(0.2, ratio))
}
return 1
}

/**
 * Scale for content the provider has never tokenized yet. Historical usage may
 * safely calibrate upward, but a ratio below 1 is composition-specific and can
 * badly undercount code/JSON-heavy tool results that follow a prose-heavy prefix.
 */
export function unreportedTokenScale(messages: readonly unknown[]): number {
return Math.max(1, tokenScale(messages))
}

/**
 * Pessimistic token estimate for a message list (see `BYTES_PER_TOKEN`).
 * Used to size the summary ceiling against what a compaction drops; the
 * precise number does not matter, only that it scales with the real content.
 */
export function estimateMessagesTokens(messages: readonly unknown[]): number {
  let total = 0
  for (const message of messages) total += estimatedTokens(message)
  return total
}

/**
 * Headroom for the part of the request that had to be estimated.
 *
 * It scales with that estimate rather than with the window: the reported prefix
 * is exact, so a fixed fraction of a 131k window would be ~6.5k of pure waste on
 * a request whose only uncertain content is the ask, and that waste is exactly
 * what stops the continuation being chosen when a conversation is near the
 * limit. Where nothing is reported the whole request is estimated, and then a
 * proportional margin is the right conservative choice.
 */
function marginFor(estimated: number, explicit: number | undefined): number {
  return explicit ?? Math.max(256, Math.ceil(estimated * 0.5))
}

/**
 * Whether the continuation request is expected to fit the server's context.
 *
 * The bulk of a continuation is the last live request's prompt, and that size
 * is known exactly: the server reported it as `usage` on the trailing assistant
 * message. Only the delta — the trailing turn plus the ask — has to be
 * estimated. Without reported usage the whole request is estimated, which is
 * pessimistic but safe.
 */
function continuationOutputBudget(args: {
  contextWindow: number | undefined
  messages: readonly unknown[]
  ask: string
  marginTokens?: number
  /** Exact token count of messages when they are a previously sent provider prefix. */
  reportedPrefixTokens?: number
  /** See `tokenScale`: multiplies the estimated (not the reported) part. */
  scale?: number
  /** Cold prompts must not reuse usage metadata captured on messages in another request. */
  ignoreReportedUsage?: boolean
  }): number | undefined {
  // An unknown window cannot be checked; leave the caller's output ceiling alone.
  if (typeof args.contextWindow !== "number" || !Number.isFinite(args.contextWindow))
    return undefined

  let reported = 0
  let reportedIndex = -1
  if (args.ignoreReportedUsage !== true) {
  for (let index = args.messages.length - 1; index >= 0; index--) {
  const tokens = promptTokensOf(args.messages[index])
  if (tokens !== undefined) {
  reported = tokens
  reportedIndex = index
  break
  }
  }
  }

  const scale = args.scale && args.scale > 0 ? args.scale : 1
  const askTokens = Math.ceil(estimatedTokens(args.ask) * scale)
  if (
    typeof args.reportedPrefixTokens === "number" &&
    Number.isFinite(args.reportedPrefixTokens) &&
    args.reportedPrefixTokens >= 0
  ) {
    return Math.max(
      0,
      args.contextWindow -
        Math.floor(args.reportedPrefixTokens) -
        askTokens -
        marginFor(askTokens, args.marginTokens),
    )
  }
  // The reported number covers the prompt *before* the message that carries it,
  // so that message counts toward the estimate along with everything after it.
  let estimated = askTokens
  if (reportedIndex < 0) {
    for (const message of args.messages) estimated += Math.ceil(estimatedTokens(message) * scale)
    return Math.max(0, args.contextWindow - estimated - marginFor(estimated, args.marginTokens))
  }
  for (const message of args.messages.slice(reportedIndex)) {
    estimated += Math.ceil(estimatedTokens(message) * scale)
  }
  return Math.max(
    0,
    args.contextWindow - reported - estimated - marginFor(estimated, args.marginTokens),
  )
}

export function continuationFits(args: {
  contextWindow: number | undefined
  maxTokens: number
  messages: readonly unknown[]
  ask: string
  marginTokens?: number
  /** See `tokenScale`: multiplies the estimated (not the reported) part. */
  scale?: number
}): boolean {
  const budget = continuationOutputBudget(args)
  return budget === undefined || args.maxTokens <= budget
}

export interface ProjectedEntryLike {
  sourceEntry: { id: string }
  messages: readonly unknown[]
}

/**
 * The messages the live request would send before the entry Pi is about to keep.
 *
 * That span is exactly what compaction drops, so it is what the summary should
 * *describe*. It is deliberately not what the summary request *sends*: on an
 * append-only cache (llama.cpp slots) a request that rewinds to a prefix of the
 * live prompt re-prefills from scratch, while a forward continuation reuses the
 * checkpoint. The request therefore carries the whole message list and this
 * span only supplies the boundary the ask names. See `continuation` in
 * config.ts and `renderSummaryAsk`.
 *
 * Returns undefined when the boundary is not in the projection, so the caller
 * can fall back to the preparation's message lists.
 */
export function messagesBeforeEntry(
  entries: readonly ProjectedEntryLike[],
  firstKeptEntryId: string,
): unknown[] | undefined {
  const index = entries.findIndex((entry) => entry.sourceEntry?.id === firstKeptEntryId)
  if (index < 0) return undefined
  return entries.slice(0, index).flatMap((entry) => [...entry.messages])
}

/**
 * Build the summarization request: the same system prompt, the same tool
 * declarations, the conversation, then one appended user turn (the ask).
 *
 * This is the whole point of the plugin. Pi's default summary is a brand-new
 * prompt (its own system prompt, the transcript re-serialized into a single
 * user message), so a prefix-caching server must re-read the conversation. A
 * continuation of the live prompt only prefills the ask.
 *
 * The Pi session projection already embeds the leading system message (prompt
 * and tool declarations) as its first entry. Pass `systemPrompt`/`tools` only
 * when it does not — otherwise the prompt would be declared twice and the
 * prefix would no longer match.
 */
export function buildSummaryContext(args: {
  systemPrompt?: string
  tools?: Tool[]
  messages: Message[]
  ask: string
  now?: number
}): SummaryContext {
  const ask: Message = {
    role: "user",
    content: [{ type: "text", text: args.ask }],
    timestamp: args.now ?? Date.now(),
  }
  return {
    systemPrompt: args.systemPrompt ?? "",
    tools: args.tools ?? [],
    messages: [...args.messages, ask],
  }
}

/** Concatenate the visible text blocks of an assistant response. */
export function extractSummaryText(content: AssistantMessage["content"]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim()
}

export type SummaryCheck = Pick<AssistantMessage, "stopReason" | "content" | "errorMessage">

/**
 * Return a reason to reject a summary response, or `undefined` when it is safe
 * to persist. A truncated (length) or tool-calling reply must never become the
 * new conversation prefix.
 */
export function summaryRejection(response: SummaryCheck): string | undefined {
  if (response.stopReason === "error") {
    return response.errorMessage || "the provider returned an error"
  }
  if (response.stopReason === "aborted") {
    return "the summary was aborted"
  }
  if (response.stopReason === "length") {
    return "the summary hit the token cap and is incomplete"
  }
  if (response.content.some((block) => block.type === "toolCall")) {
    return PARSED_TOOL_CALL_REPLY
  }
  if (!extractSummaryText(response.content)) {
    return NO_TEXT_REPLY
  }
  if (looksLikeToolCall(extractSummaryText(response.content))) {
    return TOOL_CALL_TEXT_REPLY
  }
  return undefined
}

export function preserveSummaryOrdinalRejection(
summary: string,
allowedOrdinals: readonly number[],
): string | undefined {
const allowed = new Set(allowedOrdinals)
const found = new Set<number>()
for (const match of summary.matchAll(/^### User message (\d+)\s*$/gim)) {
found.add(Number(match[1]))
}
const unexpected = [...found].filter((ordinal) => !allowed.has(ordinal))
if (unexpected.length > 0) {
  return `the preserve summary invented user-message heading(s): ${unexpected.join(", ")}`
}
return undefined
}
/**
 * Tool-call syntax that arrived as *text* rather than as a parsed tool call.
 * Seen in practice: a model asked to summarize replied with
 * `<tool_call><function=bash><parameter=command>…` because the request is a
 * continuation and it decided to keep working. `summaryRejection` cannot catch
 * that with a `toolCall` block check, and the text would be persisted as the
 * conversation prefix.
 */
export function looksLikeToolCall(text: string): boolean {
  return /<tool_call>|<\|tool_call\|>|<function=|<tool_use>|<function_calls>|\[tool_call\]/i.test(
    text,
  )
}

/**
 * Empty, parsed-tool-call, and textual-tool-call replies are worth one deterministic
 * text-only retry. Token-cap/error/abort responses need a different recovery path.
 */
export const NO_TEXT_REPLY = "the model returned no summary text"

/** A parsed provider tool call rather than summary text. */
export const PARSED_TOOL_CALL_REPLY = "the model tried to call a tool instead of writing the summary"

/** The reply was tool-call syntax rather than a summary. Retried once: the nudge
 * tells the model to stay in text, and a cache hit makes the retry cheap. */
export const TOOL_CALL_TEXT_REPLY = "the model replied with a tool call instead of a summary"

/**
 * The reasoning effort a live request actually put on the wire, or `null`
 * when the request sent none. On OpenAI-compatible "next"-style servers the
 * effort is rendered *into the prompt tokens*, so omitted, "low" and
 * "medium" are three distinct prefix-cache keys; the summary ask must
 * reproduce whatever the cached live prefix was sent with, not whatever the
 * user has selected right now. `undefined` means "not observable" (payload
 * is not a request object, or a non-OpenAI field layout we do not parse).
 */
export type LiveEffort = string | null

export function extractLiveReasoningEffort(payload: unknown): LiveEffort | undefined {
  // An object payload is complete truth: it either carries the effort or it
  // does not, and "does not" is itself a cache variant to reproduce.
  if (typeof payload !== "object" || payload === null) return undefined
  const record = payload as Record<string, unknown>
  // "openai" thinkingFormat uses reasoning_effort; "openrouter" uses
  // reasoning: { effort }. Any other layout (anthropic budgets, plain
  // non-thinking servers) sends no OpenAI-style effort -> null.
  if (typeof record.reasoning_effort === "string") return record.reasoning_effort
  const nested = record.reasoning
  if (typeof nested === "object" && nested !== null && typeof (nested as any).effort === "string") {
    return (nested as any).effort as string
  }
  return null
}

/**
 * Effort for the summarization request: explicit config wins; otherwise
 * mirror the last live request of the session. `null` (live sent no effort)
 * and `undefined` (never observed) both mean "omit the key", which is also
 * the pre-dynamic behaviour.
 */
export function resolveSummaryReasoningEffort(
  configured: string | undefined,
  observed: LiveEffort | undefined,
): string | undefined {
  // "off" omits the field (the server keeps its default, which for a reasoning
  // model means thinking stays on); "none" is a value the server understands as
  // "do not reason", and is deliberately *not* handed to the chat template.
  if (configured === "off") return undefined
  if (configured) return configured
  return observed ?? undefined
}

/**
 * Tool choice from the last live provider payload. Null means the live request
 * omitted the field, which is a distinct cache variant we must reproduce.
 * Undefined means the payload was not observable or used a tool-choice shape
 * this extension cannot represent through pi-ai's summary options.
 */
export type LiveToolChoice = "auto" | "none" | null

export function extractLiveToolChoice(payload: unknown): LiveToolChoice | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const value = record.tool_choice ?? record.tools_choice
  if (value === undefined) return null
  return value === "auto" || value === "none" ? value : undefined
}

/**
 * Summary tool choice: an explicit config override wins for normal requests;
 * otherwise cache-friendly summaries mirror the last live payload exactly.
 * Delta-only and semantic text-only retries can force tools off because they do
 * not benefit from preserving the old live request's cache identity.
 */
export function resolveSummaryToolChoice(
  configured: "auto" | "none" | undefined,
  observed: LiveToolChoice | undefined,
  forceNone = false,
): "auto" | "none" | undefined {
  if (forceNone) return "none"
  if (configured) return configured
  return observed ?? undefined
}

/**
 * Headers to copy from the live request onto the summarization request.
 *
 * The payload body is already mirrored byte-for-byte, but cache reuse on some
 * servers is keyed or routed by request headers (session affinity, routing
 * keys) that never appear in the payload dump. Capturing what the live
 * requests actually send — and reproducing it — removes the last
 * request-identity difference between a live turn and our ask.
 *
 * Dropped: hop-by-hop / transport-managed headers, and anything fetch would
 * reject or that would corrupt the new request (length, host, encoding...).
 * `null` deletions are dropped rather than replayed.
 */
const NON_REPLAYED_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
])

export function replayableHeaders(
  headers: Record<string, string | null> | undefined | null,
): Record<string, string | null> | undefined {
  if (!headers) return undefined
  let found = false
  const out: Record<string, string | null> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (NON_REPLAYED_HEADERS.has(name.toLowerCase())) continue
    // null means "delete this header" in pi's bag; replaying that against our
    // fresh request would delete a header we need. Drop the instruction.
    if (value === null) continue
    out[name] = value
    found = true
  }
  return found ? out : undefined
}

/**
 * Technical output ceiling for a summary request.
 *
 * Preserve mode has one sizing policy: reserveTokens. The request planner clips
 * that ceiling again to the real space left by the previous provider prefix and
 * the appended summary ask. Non-preserve mode keeps Pi's 0.8 x reserve behavior.
 */
export function summaryOutputCap(args: {
  reserveTokens?: number
  modelMaxTokens?: number
  preserveDialogue?: boolean
}): number {
  const reserveTokens = args.reserveTokens ?? DEFAULT_PRESERVE_RESERVE_TOKENS
  const reserveCap =
    args.preserveDialogue === true
      ? Math.max(1, Math.floor(Math.max(0, reserveTokens)))
      : Math.max(1, Math.floor(0.8 * Math.max(0, reserveTokens)))
  const modelCap =
    args.modelMaxTokens && args.modelMaxTokens > 0 ? args.modelMaxTokens : Number.POSITIVE_INFINITY
  return Math.max(1, Math.min(reserveCap, modelCap))
}

/** Only the shape this module needs; Pi's `FileOperations` matches it. */
export type FileOperationsLike = {
  read?: Iterable<string>
  written?: Iterable<string>
  edited?: Iterable<string>
}

/**
 * Pi's split of the session's file operations: anything written or edited is
 * "modified", and reads are the rest (sorted). Copied from Pi's compaction
 * utils so the appended list matches what its own compaction would write.
 */
export function computeFileLists(fileOps: FileOperationsLike | undefined): {
  readFiles: string[]
  modifiedFiles: string[]
} {
  // A host without file tracking (or an older Pi) simply has nothing to list.
  const modified = new Set<string>([...(fileOps?.edited ?? []), ...(fileOps?.written ?? [])])
  const readFiles = [...(fileOps?.read ?? [])].filter((file) => !modified.has(file)).sort()
  return { readFiles, modifiedFiles: [...modified].sort() }
}

/**
 * File appendix state for preserve mode, which summarizes every tool call that
 * exists at compaction time rather than Pi's native keepRecentTokens cut.
 */
export function computeFileListsFromMessages(
  messages: readonly { role?: string; content?: unknown }[],
  previous?: { readFiles?: readonly string[]; modifiedFiles?: readonly string[] },
): { readFiles: string[]; modifiedFiles: string[] } {
  const read = new Set<string>(previous?.readFiles ?? [])
  const modified = new Set<string>(previous?.modifiedFiles ?? [])
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (typeof block !== "object" || block === null) continue
      const tool = block as { type?: unknown; name?: unknown; arguments?: unknown }
      if (tool.type !== "toolCall" || typeof tool.name !== "string") continue
      if (typeof tool.arguments !== "object" || tool.arguments === null) continue
      const path = (tool.arguments as { path?: unknown }).path
      if (typeof path !== "string" || path.length === 0) continue
      if (tool.name === "read") {
        if (!modified.has(path)) read.add(path)
      } else if (tool.name === "write" || tool.name === "edit") {
        modified.add(path)
        read.delete(path)
      }
    }
  }
  return { readFiles: [...read].sort(), modifiedFiles: [...modified].sort() }
}

/**
 * Pi's file appendix for a summary: `<read-files>` / `<modified-files>` blocks,
 * preceded by a blank line, or "" when there is nothing to list.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = []
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`)
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`)
  }
  if (sections.length === 0) return ""
  return `\n\n${sections.join("\n\n")}`
}

/** Empty `models` means "every model". */
export function isModelAllowed(
  models: readonly string[] | undefined,
  provider: string,
  id: string,
): boolean {
  if (!models || models.length === 0) return true
  return models.includes(`${provider}/${id}`)
}

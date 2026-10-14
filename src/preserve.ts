import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  sessionEntryToContextMessages,
  type CompactionEntry,
  type ContextEditEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent"

export const PRESERVE_DIALOGUE_MODE = "preserve-dialogue-v1"
export const PRESERVE_DIALOGUE_CHECKPOINT_TYPE = "cache-compact-preserve-checkpoint"

export type CacheCompactDetails = {
  readFiles?: string[]
  modifiedFiles?: string[]
  cacheCompact?: {
    mode: typeof PRESERVE_DIALOGUE_MODE
    version: 1
  }
  checkpoint?: {
    summary: string
    tokensBefore: number
    /** Append-only checkpoint ordinal within the active preserve history. */
    number?: number
    /** Absolute user-message ordinals whose new tool activity this checkpoint covers. */
    coveredUserMessages?: number[]
    /** First raw branch entry deliberately left after this checkpoint. */
    rawTailStartEntryId?: string
  }
}

export const PRESERVE_DIALOGUE_MARKER: NonNullable<CacheCompactDetails["cacheCompact"]> = {
  mode: PRESERVE_DIALOGUE_MODE,
  version: 1,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasPreserveMarker(details: unknown): details is CacheCompactDetails {
  if (!isRecord(details)) return false
  const marker = details.cacheCompact
  return isRecord(marker) && marker.mode === PRESERVE_DIALOGUE_MODE && marker.version === 1
}

export function isPreserveDialogueCompaction(
  entry: SessionEntry | undefined,
): entry is CompactionEntry<CacheCompactDetails> {
  return entry?.type === "compaction" && hasPreserveMarker(entry.details)
}

export function isPreserveDialogueCheckpoint(
  entry: SessionEntry | undefined,
): entry is Extract<SessionEntry, { type: "custom_message" }> & { details: CacheCompactDetails } {
  return (
    entry?.type === "custom_message" &&
    entry.customType === PRESERVE_DIALOGUE_CHECKPOINT_TYPE &&
    hasPreserveMarker(entry.details)
  )
}

export type PreserveDialogueState = {
  entry: SessionEntry
  index: number
  summary: string
  details?: CacheCompactDetails
}

function latestEdits(branchEntries: readonly SessionEntry[]): Map<string, ContextEditEntry> {
  const edits = new Map<string, ContextEditEntry>()
  for (const entry of branchEntries) {
    if (entry.type === "context_edit") edits.set(entry.targetId, entry)
  }
  return edits
}

function isEntryRemoved(
  entry: SessionEntry,
  edits: ReadonlyMap<string, ContextEditEntry>,
): boolean {
  if (!("id" in entry) || typeof entry.id !== "string") return false
  return edits.get(entry.id)?.replacement === null
}

/**
 * Active preserve checkpoints in model-visible order.
 *
 * A legacy preserve-marked Pi compaction is an aggregate baseline: it supersedes
 * earlier checkpoint summaries while user/assistant dialogue before it is restored.
 * Modern manual preserve compactions carry an explicit checkpoint ordinal and are
 * append-only, so earlier active custom/manual checkpoints remain visible. Old
 * custom checkpoints nulled by pre-append-only versions remain ignored.
 */
export function preserveDialogueStates(
  branchEntries: readonly SessionEntry[],
): PreserveDialogueState[] {
  const edits = latestEdits(branchEntries)
  const states: PreserveDialogueState[] = []

  for (let index = 0; index < branchEntries.length; index += 1) {
    const entry = branchEntries[index]
    if (entry.type === "compaction") {
      if (!isPreserveDialogueCompaction(entry)) {
        states.length = 0
        continue
      }
      const state = {
        entry,
        index,
        summary: entry.summary,
        details: entry.details,
      }
      // Legacy preserve compactions were aggregate baselines and therefore
      // supersede earlier checkpoint state. Modern manual preserve compactions
      // carry an explicit checkpoint ordinal and are append-only checkpoints:
      // retain the earlier immutable states and append this one.
      if (typeof entry.details?.checkpoint?.number !== "number") states.length = 0
      states.push(state)
      continue
    }

    if (!isPreserveDialogueCheckpoint(entry) || isEntryRemoved(entry, edits)) continue
    const checkpoint = entry.details.checkpoint
    if (!checkpoint) continue
    states.push({ entry, index, summary: checkpoint.summary, details: entry.details })
  }

  return states
}

export function latestPreserveDialogueState(
  branchEntries: readonly SessionEntry[],
): PreserveDialogueState | undefined {
  return preserveDialogueStates(branchEntries).at(-1)
}

function applyEdit(
  message: AgentMessage,
  edit: ContextEditEntry | undefined,
): AgentMessage | undefined {
  if (!edit) return message
  if (edit.replacement === null) return undefined

  if (
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "toolResult" &&
    message.role !== "custom"
  ) {
    return message
  }

  const replacement = edit.replacement.content
  const content =
    (message.role === "assistant" || message.role === "toolResult") &&
    typeof replacement === "string"
      ? [{ type: "text", text: replacement }]
      : replacement
  return { ...message, content } as AgentMessage
}

function entryTimestampMs(entry: SessionEntry): number | undefined {
  if (!("timestamp" in entry)) return undefined
  const value = entry.timestamp
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function checkpointProjectionTimestamp(branchEntries: readonly SessionEntry[]): string {
  let latest = 0
  for (const entry of branchEntries) {
    const entryTimestamp = entryTimestampMs(entry)
    if (entryTimestamp !== undefined) latest = Math.max(latest, entryTimestamp)
    if (entry.type === "message" && Number.isFinite(entry.message.timestamp)) {
      latest = Math.max(latest, entry.message.timestamp)
    }
  }
  return new Date((latest > 0 ? latest : Date.now()) + 1).toISOString()
}

function entryMessages(entry: SessionEntry, edit: ContextEditEntry | undefined): AgentMessage[] {
  const checkpointTimestamp = isPreserveDialogueCheckpoint(entry)
    ? entryTimestampMs(entry)
    : undefined
  return sessionEntryToContextMessages(entry)
    .map((message) => applyEdit(message, edit))
    .filter((message): message is AgentMessage => message !== undefined)
    .map((message) =>
      checkpointTimestamp === undefined
        ? message
        : ({ ...message, timestamp: checkpointTimestamp } as AgentMessage),
    )
}

function compactionCheckpointMessages(
  entry: Extract<SessionEntry, { type: "compaction" }>,
): AgentMessage[] {
  const converted = entryMessages(entry, undefined).filter((message) => message.role !== "system")
  if (converted.length > 0) return converted
  return [
    {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: Number.isFinite(Date.parse(entry.timestamp)) ? Date.parse(entry.timestamp) : 0,
    } as AgentMessage,
  ]
}


export function isPreservedAssistantReply(
message: AgentMessage,
): message is Extract<AgentMessage, { role: "assistant" }> {
if (message.role !== "assistant" || message.stopReason !== "stop") return false
if (!Array.isArray(message.content)) return false
if (message.content.some((block) => block.type === "toolCall")) return false
return message.content.some((block) => block.type === "text")
}

function preservedDialogueMessage(
entry: SessionEntry,
edit: ContextEditEntry | undefined,
): AgentMessage | undefined {
if (entry.type !== "message") return undefined
const edited = applyEdit(entry.message, edit)
if (!edited) return undefined

if (edited.role === "user") return edited
if (!isPreservedAssistantReply(edited)) return undefined

const content = edited.content.filter((block) => block.type === "text")
return { ...edited, content } as AgentMessage
}

function preservedContextDialogueMessage(
  entry: SessionEntry,
  edit: ContextEditEntry | undefined,
): AgentMessage | undefined {
  const message = preservedDialogueMessage(entry, edit)
  if (!message || message.role !== "assistant") return message

  // Provider usage belongs to the pre-checkpoint prompt. Keeping it on restored
  // historical prose makes Pi's context estimator treat removed raw tool state
  // as if it were still present and can clamp the first post-checkpoint reply
  // to one token. Keep the prose/timestamp, but make that stale usage ineligible.
  return {
    ...message,
    usage: {
      ...message.usage,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    },
  } as AgentMessage
}

/**
* User messages + completed assistant replies only. Tool-use/interrupted assistant
* text stays technical state. Checkpoints are accounted separately.
*/
export function preservedDialogueMessages(
  branchEntries: readonly SessionEntry[],
  endExclusive = branchEntries.length,
): AgentMessage[] {
  const edits = latestEdits(branchEntries)
  const dialogue: AgentMessage[] = []
  for (const entry of branchEntries.slice(0, endExclusive)) {
    const preserved = preservedDialogueMessage(
      entry,
      entry.type === "message" ? edits.get(entry.id) : undefined,
    )
    if (preserved) dialogue.push(preserved)
  }
  return dialogue
}


/**
 * Every immutable preserve checkpoint currently visible to the model.
 * Historical checkpoints are part of the cached prefix and are never folded
 * into later checkpoints.
 */
export function preservedCheckpointMessages(
  branchEntries: readonly SessionEntry[],
  endExclusive = branchEntries.length,
): AgentMessage[] {
  const edits = latestEdits(branchEntries)
  const states = preserveDialogueStates(branchEntries)
  const messages: AgentMessage[] = []
  for (const state of states) {
    if (state.index >= endExclusive) break
    if (isPreserveDialogueCheckpoint(state.entry)) {
      messages.push(...entryMessages(state.entry, edits.get(state.entry.id)))
      continue
    }
    if (state.entry.type === "compaction") {
      messages.push(...compactionCheckpointMessages(state.entry))
    }
  }
  return messages
}

/**
 * Permanent preserve-mode model context, in original branch order:
 * user messages, completed assistant replies, and every active immutable tool
 * checkpoint. Raw tool traffic/reasoning is excluded.
 */
export function preservedContextMessages(
  branchEntries: readonly SessionEntry[],
  endExclusive = branchEntries.length,
): AgentMessage[] {
  const edits = latestEdits(branchEntries)
  const states = new Map(
    preserveDialogueStates(branchEntries).map((state) => [state.index, state] as const),
  )
  const out: AgentMessage[] = []

  for (let index = 0; index < Math.min(endExclusive, branchEntries.length); index += 1) {
    const entry = branchEntries[index]
    if (entry.type === "message") {
      const preserved = preservedContextDialogueMessage(entry, edits.get(entry.id))
      if (preserved) out.push(preserved)
      continue
    }

    const state = states.get(index)
    if (!state) continue
    if (isPreserveDialogueCheckpoint(state.entry)) {
      out.push(...entryMessages(state.entry, edits.get(state.entry.id)))
      continue
    }

    if (state.entry.type === "compaction") {
      out.push(...compactionCheckpointMessages(state.entry))
    }
  }

  return out
}

function rawTailStartIndex(
  branchEntries: readonly SessionEntry[],
  state: PreserveDialogueState | undefined,
): number | undefined {
  const id = state?.details?.checkpoint?.rawTailStartEntryId
  if (!id) return undefined
  const index = branchEntries.findIndex((entry) => "id" in entry && entry.id === id)
  return index >= 0 ? index : undefined
}

function preserveDeltaStartIndex(branchEntries: readonly SessionEntry[]): number {
  const latest = latestPreserveDialogueState(branchEntries)
  const tail = rawTailStartIndex(branchEntries, latest)
  return tail ?? (latest ? latest.index + 1 : 0)
}

function entryIndexOrEnd(
  branchEntries: readonly SessionEntry[],
  entryId: string | undefined,
): number {
  if (!entryId) return branchEntries.length
  const index = branchEntries.findIndex((entry) => "id" in entry && entry.id === entryId)
  return index >= 0 ? index : branchEntries.length
}

/** Raw model-visible messages not yet owned by an immutable checkpoint. */
export function preserveDialogueDeltaMessages(
  branchEntries: readonly SessionEntry[],
  endExclusiveEntryId?: string,
): AgentMessage[] {
  const edits = latestEdits(branchEntries)
  const start = preserveDeltaStartIndex(branchEntries)
  const end = entryIndexOrEnd(branchEntries, endExclusiveEntryId)
  return branchEntries
    .slice(start, end)
    .filter((entry) => !isPreserveDialogueCheckpoint(entry))
    .flatMap((entry) =>
      entryMessages(entry, "id" in entry ? edits.get(entry.id as string) : undefined),
    )
}

/**
 * Safe boundaries for carrying the newest part of an oversized technical delta
 * forward as raw state. A boundary is always before a user/assistant message,
 * never before a tool result, so an assistant tool-call batch stays with its
 * following results. Returned IDs are in branch order.
 */
export function preserveDeltaTailCandidates(
  branchEntries: readonly SessionEntry[],
  endExclusiveEntryId?: string,
): string[] {
  const edits = latestEdits(branchEntries)
  const start = preserveDeltaStartIndex(branchEntries)
  const end = entryIndexOrEnd(branchEntries, endExclusiveEntryId)
  const candidates: string[] = []
  let rawSeen = false

  for (let index = start; index < end; index += 1) {
    const entry = branchEntries[index]
    if (entry?.type !== "message") continue
    const edited = applyEdit(entry.message, edits.get(entry.id))
    if (!edited) continue

    if (rawSeen && (edited.role === "user" || edited.role === "assistant")) {
      candidates.push(entry.id)
    }

    if (edited.role === "toolResult") {
      rawSeen = true
      continue
    }
    if (edited.role === "assistant") {
      const content = Array.isArray(edited.content) ? edited.content : []
      const completedReply = preservedDialogueMessage(entry, edits.get(entry.id))
      if (completedReply === undefined || content.some((block) => block.type !== "text")) {
        rawSeen = true
      }
    }
  }

  return candidates
}

export type PreserveDeltaScope = {
  checkpointCount: number
  nextCheckpointNumber: number
  coveredUserMessages: number[]
  /** Branch entries that contain compactable raw state in this delta, in order. */
  rawEntryIds: string[]
  /** First branch entry that contains compactable raw state in this delta. */
  firstRawEntryId?: string
  /** Last branch entry that contains compactable raw state in this delta. */
  lastRawEntryId?: string
  rawEntryCount: number
}

/**
 * Absolute user-message ordinals associated with new tool activity since the
 * latest checkpoint. The active user may precede the checkpoint when a tool
 * loop continues the same user turn across checkpoints.
 */
export function preserveDeltaScope(
  branchEntries: readonly SessionEntry[],
  endExclusiveEntryId?: string,
): PreserveDeltaScope {
  const edits = latestEdits(branchEntries)
  const start = preserveDeltaStartIndex(branchEntries)
  const end = entryIndexOrEnd(branchEntries, endExclusiveEntryId)
  let userNumber = 0
  const covered = new Set<number>()
  const rawEntryIds: string[] = []

  for (let index = 0; index < branchEntries.length; index += 1) {
    const entry = branchEntries[index]
    if (entry?.type !== "message") continue
    const edited = applyEdit(entry.message, edits.get(entry.id))
    if (!edited) continue
    if (edited.role === "user") {
      userNumber += 1
      continue
    }
    if (index < start || index >= end) continue

    let isRaw = false
    if (edited.role === "toolResult") {
      isRaw = true
      if (userNumber > 0) covered.add(userNumber)
    } else if (edited.role === "assistant") {
    const content = Array.isArray(edited.content) ? edited.content : []
    const completedReply = preservedDialogueMessage(entry, edits.get(entry.id))
    isRaw = completedReply === undefined || content.some((block) => block.type !== "text")
    if (content.some((block) => block.type === "toolCall") && userNumber > 0) {
    covered.add(userNumber)
    }
    }
    // Assistant reasoning/tool calls and assistant text that is not a completed
    // reply are compactable raw state, as are tool results. System/developer/custom
    // protocol messages are context, not evidence that a tool checkpoint is needed.

    if (isRaw) rawEntryIds.push(entry.id)
  }

  const checkpointCount = preserveDialogueStates(branchEntries).length
  return {
    checkpointCount,
    nextCheckpointNumber: checkpointCount + 1,
    coveredUserMessages: [...covered],
    rawEntryIds,
    ...(rawEntryIds.length === 0
      ? {}
      : { firstRawEntryId: rawEntryIds[0], lastRawEntryId: rawEntryIds.at(-1)! }),
    rawEntryCount: rawEntryIds.length,
  }
}

export type PreserveBoundaryDraft =
  | { type: "context_edit"; targetId: string; replacement: ContextEditEntry["replacement"] }
  | {
      type: "custom_message"
      customType: string
      content: string
      display: boolean
      details?: unknown
    }

export function preserveDialogueBoundaryEntries(args: {
  branchEntries: readonly SessionEntry[]
  summary: string
  tokensBefore: number
  details: CacheCompactDetails
  rawTailStartEntryId?: string
}): PreserveBoundaryDraft[] {
  const edits = latestEdits(args.branchEntries)
  const scope = preserveDeltaScope(args.branchEntries, args.rawTailStartEntryId)
  const drafts: PreserveBoundaryDraft[] = []
  const start = preserveDeltaStartIndex(args.branchEntries)
  const end = entryIndexOrEnd(args.branchEntries, args.rawTailStartEntryId)

  for (const entry of args.branchEntries.slice(start, end)) {
  if (entry.type !== "message") continue
  const edited = applyEdit(entry.message, edits.get(entry.id))
  if (!edited) continue
  if (edited.role === "toolResult") {
  drafts.push({ type: "context_edit", targetId: entry.id, replacement: null })
  continue
  }
  if (edited.role !== "assistant") continue
  const preserved = preservedDialogueMessage(entry, edits.get(entry.id))
  drafts.push({
  type: "context_edit",
  targetId: entry.id,
  replacement:
  preserved?.role === "assistant" && Array.isArray(preserved.content)
  ? { content: preserved.content }
  : null,
  })
  }

  const details: CacheCompactDetails = {
    ...args.details,
    checkpoint: {
      summary: args.summary,
      tokensBefore: args.tokensBefore,
      number: scope.nextCheckpointNumber,
      coveredUserMessages: scope.coveredUserMessages,
      ...(args.rawTailStartEntryId ? { rawTailStartEntryId: args.rawTailStartEntryId } : {}),
    },
  }
  drafts.push({
    type: "custom_message",
    customType: PRESERVE_DIALOGUE_CHECKPOINT_TYPE,
    content: "## Tool Context Checkpoint #" + scope.nextCheckpointNumber + "\n\n" + args.summary,
    display: false,
    details,
  })
  return drafts
}

/**
 * Preview the non-system model context after a successful preserve checkpoint.
 * Older technical state is replaced by the new immutable checkpoint while the
 * triggering assistant/tool batch remains raw immediately after it.
 */
export function previewPreservedContextAfterCheckpoint(args: {
  branchEntries: readonly SessionEntry[]
  summary: string
  tokensBefore: number
  details: CacheCompactDetails
  rawTailStartEntryId?: string
}): AgentMessage[] {
  const scope = preserveDeltaScope(args.branchEntries, args.rawTailStartEntryId)
  const details: CacheCompactDetails = {
    ...args.details,
    checkpoint: {
      summary: args.summary,
      tokensBefore: args.tokensBefore,
      number: scope.nextCheckpointNumber,
      coveredUserMessages: scope.coveredUserMessages,
      ...(args.rawTailStartEntryId ? { rawTailStartEntryId: args.rawTailStartEntryId } : {}),
    },
  }
  const checkpoint = {
    type: "custom_message",
    timestamp: checkpointProjectionTimestamp(args.branchEntries),
    customType: PRESERVE_DIALOGUE_CHECKPOINT_TYPE,
    content: "## Tool Context Checkpoint #" + scope.nextCheckpointNumber + "\n\n" + args.summary,
    display: false,
    details,
  } as SessionEntry
  const tailStart = entryIndexOrEnd(args.branchEntries, args.rawTailStartEntryId)
  const edits = latestEdits(args.branchEntries)
  const tail = args.rawTailStartEntryId
    ? args.branchEntries
        .slice(tailStart)
        .filter((entry) => !isPreserveDialogueCheckpoint(entry))
        .flatMap((entry) =>
          entryMessages(entry, "id" in entry ? edits.get(entry.id as string) : undefined),
        )
    : []
  return [
    ...preservedContextMessages(args.branchEntries, tailStart),
    ...entryMessages(checkpoint, undefined),
    ...tail,
  ]
}

export function rebuildPreservedDialogue(
  currentMessages: readonly AgentMessage[],
  branchEntries: readonly SessionEntry[],
): AgentMessage[] | undefined {
  const latest = latestPreserveDialogueState(branchEntries)
  if (!latest) return undefined

  const edits = latestEdits(branchEntries)
  const tailStart = rawTailStartIndex(branchEntries, latest)
  if (tailStart !== undefined && tailStart < latest.index) {
    const preserved = preservedContextMessages(branchEntries, tailStart)
    const checkpoint = entryMessages(
      latest.entry,
      "id" in latest.entry ? edits.get(latest.entry.id as string) : undefined,
    )
    const rawTail = branchEntries
      .slice(tailStart, latest.index)
      .filter((entry) => !isPreserveDialogueCheckpoint(entry))
      .flatMap((entry) =>
        entryMessages(entry, "id" in entry ? edits.get(entry.id as string) : undefined),
      )
    const afterCheckpoint = branchEntries
      .slice(latest.index + 1)
      .flatMap((entry) =>
        entryMessages(entry, "id" in entry ? edits.get(entry.id as string) : undefined),
      )
    return [...preserved, ...checkpoint, ...rawTail, ...afterCheckpoint]
  }

  const preserved = preservedContextMessages(branchEntries, latest.index + 1)
  const afterCheckpoint = branchEntries
    .slice(latest.index + 1)
    .flatMap((entry) =>
      entryMessages(entry, "id" in entry ? edits.get(entry.id as string) : undefined),
    )

  if (preserved.length === 0 && currentMessages.length === 0) return undefined
  return [...preserved, ...afterCheckpoint]
}

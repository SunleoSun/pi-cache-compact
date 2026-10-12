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
  return (
    isRecord(marker) &&
    marker.mode === PRESERVE_DIALOGUE_MODE &&
    marker.version === 1
  )
}

export function isPreserveDialogueCompaction(entry: SessionEntry | undefined): entry is CompactionEntry<CacheCompactDetails> {
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

function isEntryRemoved(entry: SessionEntry, edits: ReadonlyMap<string, ContextEditEntry>): boolean {
  if (!("id" in entry) || typeof entry.id !== "string") return false
  return edits.get(entry.id)?.replacement === null
}

/**
 * Active preserve checkpoints in model-visible order.
 *
 * A legacy preserve-marked Pi compaction is a baseline checkpoint: raw tool
 * traffic before it must stay hidden, while user/assistant dialogue before it
 * is restored separately. Append-only custom checkpoints after that baseline
 * are all retained. Old custom checkpoints nulled by pre-append-only versions
 * remain ignored for restart compatibility.
 */
export function preserveDialogueStates(
  branchEntries: readonly SessionEntry[],
): PreserveDialogueState[] {
  const edits = latestEdits(branchEntries)
  let lastCompactionIndex = -1
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    if (branchEntries[index]?.type === "compaction") {
      lastCompactionIndex = index
      break
    }
  }

  const states: PreserveDialogueState[] = []
  if (lastCompactionIndex >= 0) {
    const baseline = branchEntries[lastCompactionIndex]
    if (isPreserveDialogueCompaction(baseline)) {
      states.push({
        entry: baseline,
        index: lastCompactionIndex,
        summary: baseline.summary,
        details: baseline.details,
      })
    }
  }

  for (let index = Math.max(0, lastCompactionIndex + 1); index < branchEntries.length; index += 1) {
    const entry = branchEntries[index]
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

function applyEdit(message: AgentMessage, edit: ContextEditEntry | undefined): AgentMessage | undefined {
  if (!edit) return message
  if (edit.replacement === null) return undefined

  if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult" && message.role !== "custom") {
    return message
  }

  const replacement = edit.replacement.content
  const content =
    (message.role === "assistant" || message.role === "toolResult") && typeof replacement === "string"
      ? [{ type: "text", text: replacement }]
      : replacement
  return { ...message, content } as AgentMessage
}

function entryMessages(
  entry: SessionEntry,
  edit: ContextEditEntry | undefined,
): AgentMessage[] {
  return sessionEntryToContextMessages(entry)
    .map((message) => applyEdit(message, edit))
    .filter((message): message is AgentMessage => message !== undefined)
}

function preservedDialogueMessage(
  entry: SessionEntry,
  edit: ContextEditEntry | undefined,
): AgentMessage | undefined {
  if (entry.type !== "message") return undefined
  const edited = applyEdit(entry.message, edit)
  if (!edited) return undefined

  if (edited.role === "user") return edited
  if (edited.role !== "assistant") return undefined

  const content = Array.isArray(edited.content)
    ? edited.content.filter((block) => block.type === "text")
    : []
  if (content.length === 0) return undefined

  return { ...edited, content } as AgentMessage
}

/**
 * User messages + visible assistant prose only. This intentionally excludes
 * checkpoints so callers can account dialogue and checkpoint tokens separately.
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

function legacyBaselineIndex(branchEntries: readonly SessionEntry[]): number {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index]
    if (entry?.type !== "compaction") continue
    return isPreserveDialogueCompaction(entry) ? index : -1
  }
  return -1
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
    const converted = entryMessages(state.entry, undefined)
    if (converted.length > 0) {
      messages.push(...converted)
      continue
    }
    if (state.entry.type === "compaction") {
      messages.push({
        role: "compactionSummary",
        summary: state.summary,
        tokensBefore: state.entry.tokensBefore,
        timestamp: Number.isFinite(Date.parse(state.entry.timestamp)) ? Date.parse(state.entry.timestamp) : 0,
      } as AgentMessage)
    }
  }
  return messages
}

/**
 * Permanent preserve-mode model context, in original branch order:
 * user messages, visible assistant prose, and every active immutable tool
 * checkpoint. Raw tool traffic/reasoning is excluded.
 */
export function preservedContextMessages(
  branchEntries: readonly SessionEntry[],
  endExclusive = branchEntries.length,
): AgentMessage[] {
  const edits = latestEdits(branchEntries)
  const baseline = legacyBaselineIndex(branchEntries)
  const out: AgentMessage[] = []
  let start = 0

  if (baseline >= 0) {
  const beforeBaselineEnd = Math.min(endExclusive, baseline)
  for (let index = 0; index < beforeBaselineEnd; index += 1) {
  const entry = branchEntries[index]
  const preserved = preservedDialogueMessage(
  entry,
  entry.type === "message" ? edits.get(entry.id) : undefined,
  )
  if (preserved) out.push(preserved)
  }

  if (baseline < endExclusive) {
  const baselineEntry = branchEntries[baseline]
  if (isPreserveDialogueCompaction(baselineEntry)) {
  const converted = entryMessages(baselineEntry, undefined)
  if (converted.length > 0) out.push(...converted)
  else {
  out.push({
  role: "compactionSummary",
  summary: baselineEntry.summary,
  tokensBefore: baselineEntry.tokensBefore,
  timestamp: Number.isFinite(Date.parse(baselineEntry.timestamp)) ? Date.parse(baselineEntry.timestamp) : 0,
  } as AgentMessage)
  }
  start = baseline + 1
  }
  }
  }
  for (let index = start; index < Math.min(endExclusive, branchEntries.length); index += 1) {
    const entry = branchEntries[index]
    if (entry.type === "message") {
      const preserved = preservedDialogueMessage(entry, edits.get(entry.id))
      if (preserved) out.push(preserved)
      continue
    }
    if (isPreserveDialogueCheckpoint(entry) && !isEntryRemoved(entry, edits)) {
      out.push(...entryMessages(entry, edits.get(entry.id)))
    }
  }
  return out
}

/** Raw model-visible messages created after the latest immutable checkpoint. */
export function preserveDialogueDeltaMessages(
  branchEntries: readonly SessionEntry[],
): AgentMessage[] {
  const latest = latestPreserveDialogueState(branchEntries)
  const edits = latestEdits(branchEntries)
  const start = latest ? latest.index + 1 : 0
  return branchEntries
    .slice(start)
    .flatMap((entry) => entryMessages(entry, "id" in entry ? edits.get(entry.id as string) : undefined))
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
): PreserveDeltaScope {
const latest = latestPreserveDialogueState(branchEntries)
const edits = latestEdits(branchEntries)
const start = latest ? latest.index + 1 : 0
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
if (index < start) continue

let isRaw = false
if (edited.role === "toolResult") {
isRaw = true
if (userNumber > 0) covered.add(userNumber)
} else if (edited.role === "assistant" && Array.isArray(edited.content)) {
isRaw = edited.content.some((block) => block.type !== "text")
if (edited.content.some((block) => block.type === "toolCall") && userNumber > 0) {
covered.add(userNumber)
}
} else if (edited.role !== "assistant") {
// Preserve mode only keeps user messages and visible assistant text. Any
// other model-visible message in the delta is technical state to compact.
isRaw = true
}

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
  | { type: "custom_message"; customType: string; content: string; display: boolean; details?: unknown }

export function preserveDialogueBoundaryEntries(args: {
  branchEntries: readonly SessionEntry[]
  summary: string
  tokensBefore: number
  details: CacheCompactDetails
}): PreserveBoundaryDraft[] {
  const latest = latestPreserveDialogueState(args.branchEntries)
  const edits = latestEdits(args.branchEntries)
  const scope = preserveDeltaScope(args.branchEntries)
  const drafts: PreserveBoundaryDraft[] = []
  const start = latest ? latest.index + 1 : 0

  for (const entry of args.branchEntries.slice(start)) {
    if (entry.type !== "message") continue
    const edited = applyEdit(entry.message, edits.get(entry.id))
    if (!edited) continue
    if (edited.role === "toolResult") {
      drafts.push({ type: "context_edit", targetId: entry.id, replacement: null })
      continue
    }
    if (edited.role !== "assistant") continue
    const content = Array.isArray(edited.content)
      ? edited.content.filter((block) => block.type === "text")
      : []
    drafts.push({
      type: "context_edit",
      targetId: entry.id,
      replacement: content.length > 0 ? { content } : null,
    })
  }

  const details: CacheCompactDetails = {
    ...args.details,
    checkpoint: {
      summary: args.summary,
      tokensBefore: args.tokensBefore,
      number: scope.nextCheckpointNumber,
      coveredUserMessages: scope.coveredUserMessages,
    },
  }
  drafts.push({
    type: "custom_message",
    customType: PRESERVE_DIALOGUE_CHECKPOINT_TYPE,
    content: `## Tool Context Checkpoint #${scope.nextCheckpointNumber}\n\n${args.summary}`,
    display: false,
    details,
  })
  return drafts
}

/**
 * Preview the non-system model context after a successful preserve checkpoint.
 * It is all immutable dialogue/checkpoints plus the newly appended checkpoint;
 * no pre-checkpoint tool/reasoning state remains raw.
 */
export function previewPreservedContextAfterCheckpoint(args: {
  branchEntries: readonly SessionEntry[]
  summary: string
  tokensBefore: number
  details: CacheCompactDetails
}): AgentMessage[] {
  const scope = preserveDeltaScope(args.branchEntries)
  const details: CacheCompactDetails = {
    ...args.details,
    checkpoint: {
      summary: args.summary,
      tokensBefore: args.tokensBefore,
      number: scope.nextCheckpointNumber,
      coveredUserMessages: scope.coveredUserMessages,
    },
  }
  const checkpoint = {
    type: "custom_message",
    customType: PRESERVE_DIALOGUE_CHECKPOINT_TYPE,
    content: `## Tool Context Checkpoint #${scope.nextCheckpointNumber}\n\n${args.summary}`,
    display: false,
    details,
  } as SessionEntry
  return [
    ...preservedContextMessages(args.branchEntries),
    ...entryMessages(checkpoint, undefined),
  ]
}

export function rebuildPreservedDialogue(
  currentMessages: readonly AgentMessage[],
  branchEntries: readonly SessionEntry[],
): AgentMessage[] | undefined {
  const latest = latestPreserveDialogueState(branchEntries)
  if (!latest) return undefined

  const edits = latestEdits(branchEntries)
  const preserved = preservedContextMessages(branchEntries, latest.index + 1)
  const afterCheckpoint = branchEntries
    .slice(latest.index + 1)
    .flatMap((entry) => entryMessages(entry, "id" in entry ? edits.get(entry.id as string) : undefined))

  // Legacy compaction entries can fail to convert outside Pi's projected view.
  // `preservedContextMessages` synthesizes their summary in that case.
  if (preserved.length === 0 && currentMessages.length === 0) return undefined
  return [...preserved, ...afterCheckpoint]
}

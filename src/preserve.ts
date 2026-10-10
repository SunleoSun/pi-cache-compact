import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { CompactionEntry, ContextEditEntry, SessionEntry } from "@earendil-works/pi-coding-agent"

export const PRESERVE_DIALOGUE_MODE = "preserve-dialogue-v1"

export type CacheCompactDetails = {
  readFiles?: string[]
  modifiedFiles?: string[]
  cacheCompact?: {
    mode: typeof PRESERVE_DIALOGUE_MODE
    version: 1
  }
}

export const PRESERVE_DIALOGUE_MARKER: NonNullable<CacheCompactDetails["cacheCompact"]> = {
  mode: PRESERVE_DIALOGUE_MODE,
  version: 1,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isPreserveDialogueCompaction(entry: SessionEntry | undefined): entry is CompactionEntry<CacheCompactDetails> {
  if (entry?.type !== "compaction" || !isRecord(entry.details)) return false
  const marker = entry.details.cacheCompact
  return (
    isRecord(marker) &&
    marker.mode === PRESERVE_DIALOGUE_MODE &&
    marker.version === 1
  )
}

function latestCompaction(branchEntries: readonly SessionEntry[]): CompactionEntry | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index]
    if (entry?.type === "compaction") return entry
  }
  return undefined
}

function latestEdits(branchEntries: readonly SessionEntry[]): Map<string, ContextEditEntry> {
  const edits = new Map<string, ContextEditEntry>()
  for (const entry of branchEntries) {
    if (entry.type === "context_edit") edits.set(entry.targetId, entry)
  }
  return edits
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
 * Restore dialogue hidden by the latest preserve-dialogue compaction.
 *
 * Raw session entries are append-only, so the original user messages and
 * assistant replies remain available even though Pi's normal compaction
* projection hides them. Old tool results and tool-call blocks stay compacted
* into the technical summary; assistant thinking/reasoning is discarded.
 */
export function rebuildPreservedDialogue(
  currentMessages: readonly AgentMessage[],
  branchEntries: readonly SessionEntry[],
): AgentMessage[] | undefined {
  const compaction = latestCompaction(branchEntries)
  if (!isPreserveDialogueCompaction(compaction)) return undefined

  const boundaryIndex = branchEntries.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
  if (boundaryIndex < 0) return undefined

  const edits = latestEdits(branchEntries)
  const dialogue: AgentMessage[] = []
  for (const entry of branchEntries.slice(0, boundaryIndex)) {
    const preserved = preservedDialogueMessage(
      entry,
      entry.type === "message" ? edits.get(entry.id) : undefined,
    )
    if (preserved) dialogue.push(preserved)
  }

  const existingSummary = currentMessages.find((message) => message.role === "compactionSummary")
  const summary =
    existingSummary ??
    ({
      role: "compactionSummary",
      summary: compaction.summary,
      tokensBefore: compaction.tokensBefore,
      timestamp: Number.isFinite(Date.parse(compaction.timestamp))
        ? Date.parse(compaction.timestamp)
        : 0,
    } as AgentMessage)

  const retained = currentMessages.filter((message) => message.role !== "compactionSummary")
  return [...dialogue, summary, ...retained]
}
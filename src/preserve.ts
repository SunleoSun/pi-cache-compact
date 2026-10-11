import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
sessionEntryToContextMessages,
type CompactionEntry,
type ContextEditEntry,
type SessionEntry,
} from "@earendil-works/pi-coding-agent"

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

function latestCompaction(
branchEntries: readonly SessionEntry[],
): { entry: CompactionEntry; index: number } | undefined {
for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
const entry = branchEntries[index]
if (entry?.type === "compaction") return { entry, index }
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
* The part of the current branch that preserve-dialogue can never compact.
*
* This is also the semantic owner used by the dynamic compaction trigger:
* every user message and every visible assistant text block survives future
* compactions verbatim, while thinking/tool traffic does not.
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
* Restore the model view after the latest preserve-dialogue compaction.
*
* Everything that existed when that compaction was written is now split into
* exactly two owners:
* - user messages + visible assistant text are restored verbatim from the raw
* append-only branch;
* - every tool call/result and all assistant reasoning are represented only by
* the technical summary.
*
* Pi's native firstKeptEntryId / keepRecentTokens tail is therefore only a
* persistence detail in preserve mode. Pre-compaction retained entries are not
* replayed to the model. Messages created after the compaction remain raw until
* the next compaction, so an in-progress/new turn can still use fresh tools.
*/
export function rebuildPreservedDialogue(
currentMessages: readonly AgentMessage[],
branchEntries: readonly SessionEntry[],
): AgentMessage[] | undefined {
const latest = latestCompaction(branchEntries)
if (!latest || !isPreserveDialogueCompaction(latest.entry)) return undefined

const edits = latestEdits(branchEntries)
const dialogue = preservedDialogueMessages(branchEntries, latest.index)
const existingSummary = currentMessages.find((message) => message.role === "compactionSummary")
const summary =
existingSummary ??
({
role: "compactionSummary",
summary: latest.entry.summary,
tokensBefore: latest.entry.tokensBefore,
timestamp: Number.isFinite(Date.parse(latest.entry.timestamp))
? Date.parse(latest.entry.timestamp)
: 0,
} as AgentMessage)

const afterCompaction = branchEntries
.slice(latest.index + 1)
.flatMap((entry) => entryMessages(entry, edits.get(entry.id)))

return [...dialogue, summary, ...afterCompaction]
}
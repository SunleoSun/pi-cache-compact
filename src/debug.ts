/**
 * Debug logging and cache-prefix diagnostics.
 *
 * The JSONL file is a rolling log capped at exactly 1 MiB. When a new record
 * would cross the cap, the oldest complete JSONL records are discarded. A
 * single oversize record is replaced by a small marker so the file always
 * remains valid JSONL and bounded.
 */

import { createHash } from "node:crypto"
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs"

const HASH_LENGTH = 12
export const DEBUG_FILE_MAX_BYTES = 1024 * 1024

function hashUpdate(prev: string, value: unknown): string {
let text: string
try {
text = JSON.stringify(value) ?? String(value)
} catch {
text = String(value)
}
return createHash("sha256")
.update(`${prev} ${text}`)
.digest("hex")
.slice(0, HASH_LENGTH)
}

export function snapshot(value: unknown): unknown {
try {
return JSON.parse(JSON.stringify(value))
} catch {
return String(value)
}
}

export function shortHash(value: unknown): string {
return hashUpdate("", value)
}

const REDACTED_HEADER_NAMES = new Set([
"authorization",
"proxy-authorization",
"api-key",
"x-api-key",
"x-goog-api-key",
"openai-api-key",
"anthropic-api-key",
"x-amz-security-token",
"x-auth-token",
"x-session-token",
"cookie",
"set-cookie",
])

export function redactHeaders(
headers: Record<string, unknown> | undefined | null,
): Record<string, string> {
const out: Record<string, string> = {}
if (!headers || typeof headers !== "object") return out
for (const [name, value] of Object.entries(headers)) {
out[name] = REDACTED_HEADER_NAMES.has(name.toLowerCase())
? "[redacted]"
: String(value)
}
return out
}

export function rollingMessageHashes(messages: readonly unknown[]): string[] {
let prev = ""
return messages.map((message) => {
prev = hashUpdate(prev, message)
return prev
})
}

export function sharedPrefixLength(a: readonly string[], b: readonly string[]): number {
const n = Math.min(a.length, b.length)
for (let i = 0; i < n; i += 1) {
if (a[i] !== b[i]) return i
}
return n
}

function messageText(message: unknown): string {
const content = (message as { content?: unknown })?.content
if (typeof content === "string") return content
if (Array.isArray(content)) {
return content
.map((part) =>
typeof part === "string" ? part : String((part as { text?: unknown })?.text ?? ""),
)
.join("\n")
}
return ""
}

export function fingerprintPayload(payload: unknown): Record<string, unknown> {
let body: Record<string, unknown> = {}
try {
body = (payload ?? {}) as Record<string, unknown>
} catch {
/* keep {} */
}
const messages = Array.isArray(body.messages) ? body.messages : []
const tools = Array.isArray(body.tools) ? body.tools : []
const rolling = rollingMessageHashes(messages)
const last = messages[messages.length - 1] as { role?: unknown } | undefined
return {
model: typeof body.model === "string" ? body.model : undefined,
stream: body.stream,
toolChoice: body.tool_choice ?? body.tools_choice,
toolsCount: tools.length,
toolsHash: shortHash(tools),
messageCount: messages.length,
firstMessageHash: rolling[0] ?? null,
lastMessageRole: typeof last?.role === "string" ? last.role : undefined,
lastMessageHash: messages.length ? shortHash(last) : null,
lastMessageTextHash: messages.length ? shortHash(messageText(last)) : null,
rolling,
}
}

function byteLength(text: string): number {
return Buffer.byteLength(text, "utf8")
}

function boundedAppend(file: string, line: string): void {
const addition = `${line}\n`
const additionBytes = byteLength(addition)

if (additionBytes > DEBUG_FILE_MAX_BYTES) {
let originalKind: unknown
try {
originalKind = (JSON.parse(line) as Record<string, unknown>).kind
} catch {
originalKind = undefined
}
const marker = JSON.stringify({
ts: new Date().toISOString(),
kind: "log_record_oversize",
originalKind,
originalBytes: additionBytes,
limitBytes: DEBUG_FILE_MAX_BYTES,
}) + "\n"
boundedAppend(file, marker.trimEnd())
return
}

try {
if (!existsSync(file) || statSync(file).size + additionBytes <= DEBUG_FILE_MAX_BYTES) {
appendFileSync(file, addition)
return
}
} catch {
/* fall through and rebuild from whatever can be read */
}

let existing = ""
try {
existing = existsSync(file) ? readFileSync(file, "utf8") : ""
} catch {
existing = ""
}
const lines = existing.split(/\r?\n/).filter(Boolean)
const kept: string[] = []
let used = additionBytes
for (let index = lines.length - 1; index >= 0; index -= 1) {
const candidateBytes = byteLength(`${lines[index]}\n`)
if (used + candidateBytes > DEBUG_FILE_MAX_BYTES) break
kept.push(lines[index])
used += candidateBytes
}
kept.reverse()
const prefix = kept.length > 0 ? `${kept.join("\n")}\n` : ""
writeFileSync(file, `${prefix}${addition}`)
}

/** Human stderr diagnostics plus a bounded structured JSONL file. */
export class DebugLogger {
readonly enabled: boolean
readonly file?: string

constructor(enabled: boolean, file?: string) {
this.enabled = enabled
this.file = file
}

log(message: string, extra: Record<string, unknown> = {}): void {
if (!this.enabled) return
try {
process.stderr.write(`[cache-compact] ${message} ${JSON.stringify(extra)}\n`)
} catch {
/* logging must never affect compaction */
}
}

record(kind: string, extra: Record<string, unknown> = {}): void {
if (!this.enabled || !this.file) return
try {
const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...extra })
boundedAppend(this.file, line)
} catch {
/* logging must never affect compaction */
}
}

both(kind: string, extra: Record<string, unknown> = {}): void {
this.log(kind, extra)
this.record(kind, extra)
}
}
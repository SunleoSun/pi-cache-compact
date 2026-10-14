import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  DEBUG_FILE_MAX_BYTES,
  DebugLogger,
  compactPayloadForLog,
  fingerprintPayload,
  providerToolNames,
  snapshot,
  rollingMessageHashes,
  sharedPrefixLength,
  shortHash,
  redactHeaders,
} from "../src/debug.ts"

test("shortHash is stable and value-sensitive", () => {
  assert.equal(shortHash({ a: 1 }), shortHash({ a: 1 }))
  assert.notEqual(shortHash({ a: 1 }), shortHash({ a: 2 }))
  // Key order is part of the value, like the wire serializer.
  assert.notEqual(shortHash({ a: 1, b: 2 }), shortHash({ b: 2, a: 1 }))
  assert.doesNotThrow(() => shortHash(undefined))
  const circular: any = {}
  circular.self = circular
  assert.doesNotThrow(() => shortHash(circular))
})

test("snapshot detaches from later mutation", () => {
  const value: any = { messages: [{ role: "user", content: "hi" }] }
  const snap = snapshot(value) as any
  value.messages[0].content = "mutated"
  assert.equal(snap.messages[0].content, "hi")
  const circular: any = {}
  circular.self = circular
  assert.equal(typeof snapshot(circular), "string")
})

test("compact payload logging keeps tool names and drops full declarations", () => {
  const payload = {
    model: "m",
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "TOOL_SCHEMA_SENTINEL",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
      { name: "direct-tool", description: "ANOTHER_TOOL_SCHEMA_SENTINEL" },
    ],
    messages: [{ role: "user", content: "hello" }],
  }
  const compact = compactPayloadForLog(payload) as any
  assert.deepEqual(compact.tools, ["read", "direct-tool"])
  assert.deepEqual(providerToolNames(payload.tools), ["read", "direct-tool"])
  assert.doesNotMatch(JSON.stringify(compact), /TOOL_SCHEMA_SENTINEL/)
  const fingerprint = fingerprintPayload(payload)
  assert.deepEqual(fingerprint.toolNames, ["read", "direct-tool"])
  assert.equal(typeof fingerprint.toolsHash, "string")
})

test("rolling hashes mark exactly the divergence index", () => {
  const a = [{ role: "system" }, { role: "user" }, { role: "assistant" }]
  const b = [{ role: "system" }, { role: "user", content: "changed" }, { role: "assistant" }]
  const ra = rollingMessageHashes(a)
  const rb = rollingMessageHashes(b)
  assert.equal(sharedPrefixLength(ra, ra), 3)
  assert.equal(sharedPrefixLength(ra, rb), 1)
  // A longer list sharing the prefix still reports the shorter length.
  assert.equal(sharedPrefixLength(ra, [...rollingMessageHashes(a), "x"]), 3)
})

test("fingerprintPayload captures the OpenAI-style request shape", () => {
  const fp = fingerprintPayload({
    model: "m",
    stream: true,
    tool_choice: "none",
    tools: [{ type: "function", function: { name: "read" } }],
    messages: [
      { role: "system", content: "prompt" },
      { role: "user", content: [{ type: "text", text: "ask" }] },
    ],
  } as any)
  assert.equal(fp.model, "m")
  assert.equal(fp.stream, true)
  assert.equal(fp.toolChoice, "none")
  assert.equal(fp.toolsCount, 1)
  assert.equal(fp.messageCount, 2)
  assert.equal(fp.lastMessageRole, "user")
  assert.equal(fp.lastMessageTextHash, shortHash("ask"))
  assert.deepEqual((fp.rolling as string[]).length, 2)
})

test("fingerprintPayload survives junk", () => {
  for (const junk of [undefined, null, "string", 42, {}, { messages: "no" }]) {
    assert.doesNotThrow(() => fingerprintPayload(junk))
  }
})

test("DebugLogger appends JSONL only when enabled with a file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-compact-debug-"))
  const file = path.join(dir, "debug.jsonl")
  try {
    new DebugLogger(false, file).record("k", { a: 1 })
    assert.equal(fs.existsSync(file), false)

    new DebugLogger(true).record("k", { a: 1 }) // no file: silently dropped

    const logger = new DebugLogger(true, file)
    logger.record("first", { a: 1 })
    logger.record("second", { b: "two" })
    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as any)
    assert.equal(lines.length, 2)
    assert.equal(lines[0].kind, "first")
    assert.equal(lines[0].a, 1)
    assert.ok(lines[0].ts)
    assert.equal(lines[1].kind, "second")

    // Unwritable file must not throw.
    assert.doesNotThrow(() => new DebugLogger(true, path.join(dir, "nope", "x.jsonl")).record("k"))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("DebugLogger does not write stderr while stderr is a TTY", () => {
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY")
const writeDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "write")
let writes = 0
try {
Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true })
Object.defineProperty(process.stderr, "write", {
configurable: true,
value: () => {
writes += 1
return true
},
})
const logger = new DebugLogger(true)
logger.log("hidden-in-tui", { a: 1 })
logger.both("also-hidden-in-tui", { b: 2 })
assert.equal(writes, 0)
} finally {
if (ttyDescriptor) Object.defineProperty(process.stderr, "isTTY", ttyDescriptor)
else delete (process.stderr as any).isTTY
if (writeDescriptor) Object.defineProperty(process.stderr, "write", writeDescriptor)
else delete (process.stderr as any).write
}
})

test("DebugLogger keeps valid JSONL under the 1 MiB rolling cap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-compact-cap-"))
  const file = path.join(dir, "debug.jsonl")
  try {
    const logger = new DebugLogger(true, file)
    for (let index = 0; index < 160; index += 1) {
      logger.record("chunk", { index, text: "x".repeat(10_000) })
    }
    assert.ok(fs.statSync(file).size <= DEBUG_FILE_MAX_BYTES)
    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as any)
    assert.ok(lines.length > 0)
    assert.equal(lines.at(-1).index, 159)
    assert.ok(lines[0].index > 0, "oldest records should be evicted")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("DebugLogger rolls canonical preserve_compaction records without losing the newest audit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-compact-audit-cap-"))
  const file = path.join(dir, "debug.jsonl")
  try {
    const logger = new DebugLogger(true, file)
    for (let checkpoint = 1; checkpoint <= 18; checkpoint += 1) {
      const content = `checkpoint-${checkpoint}-` + "x".repeat(35_000)
      logger.record("preserve_compaction", {
        checkpoint: { number: checkpoint },
        contextBefore: [{ role: "tool", content }],
        contextAfter: [{ role: "custom", content: `summary-${checkpoint}` }],
        tokens: { providerContextBefore: 50_000, estimatedContextAfter: 10_000 },
      })
      logger.record("post_compaction_context", {
      checkpointNumber: checkpoint,
      context: {
      messageIndex: [
      {
      index: 0,
      role: "custom",
      kind: "custom",
      estimatedTokens: 10,
      hash: `hash-${checkpoint}`,
      },
      ],
      tools: [],
      },
      })
    }

    assert.ok(fs.statSync(file).size <= DEBUG_FILE_MAX_BYTES)
    const records = fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as any)
    assert.ok(records.length > 0)
    assert.ok(records.every((record) => typeof record.kind === "string"))
    const latestAudit = [...records]
      .reverse()
      .find((record) => record.kind === "preserve_compaction")
    const latestPost = [...records]
      .reverse()
      .find((record) => record.kind === "post_compaction_context")
    assert.equal(latestAudit?.checkpoint?.number, 18)
    assert.equal(latestPost?.checkpointNumber, 18)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
test("DebugLogger replaces a single oversize record with a bounded marker", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-compact-oversize-"))
  const file = path.join(dir, "debug.jsonl")
  try {
    new DebugLogger(true, file).record("huge", { text: "x".repeat(DEBUG_FILE_MAX_BYTES + 100_000) })
    assert.ok(fs.statSync(file).size <= DEBUG_FILE_MAX_BYTES)
    const record = JSON.parse(fs.readFileSync(file, "utf8").trim()) as any
    assert.equal(record.kind, "log_record_oversize")
    assert.equal(record.originalKind, "huge")
    assert.equal(record.limitBytes, DEBUG_FILE_MAX_BYTES)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("redactHeaders hides secrets but keeps header names visible", () => {
  const out = redactHeaders({
    Authorization: "Bearer supersecret",
    "proxy-authorization": "Basic abc",
    "x-api-key": "sk-123",
    "Set-Cookie": "session=secret",
    cookie: "a=b",
    "x-session-affinity": "aff-123",
    "user-agent": "pi/1.2.3",
    "x-null-deleted": null,
  })
  assert.deepEqual(out, {
    Authorization: "[redacted]",
    "proxy-authorization": "[redacted]",
    "x-api-key": "[redacted]",
    "Set-Cookie": "[redacted]",
    cookie: "[redacted]",
    "x-session-affinity": "aff-123",
    "user-agent": "pi/1.2.3",
    "x-null-deleted": "null",
  })
  assert.deepEqual(redactHeaders(undefined), {})
  assert.deepEqual(redactHeaders(null), {})
})

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  PRESERVE_DIALOGUE_MARKER,
  preservedDialogueMessages,
  rebuildPreservedDialogue,
} from "../src/preserve.ts"

function message(id: string, role: string, content: unknown): any {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role, content, timestamp: 1 },
  }
}

function compaction(id: string, firstKeptEntryId: string, summary = "TOOL SUMMARY", preserve = true): any {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    summary,
    firstKeptEntryId,
    tokensBefore: 1000,
    details: preserve ? { cacheCompact: PRESERVE_DIALOGUE_MARKER } : {},
  }
}

test("preservedDialogueMessages exposes exactly the non-compressible dialogue", () => {
  const branch = [
    message("u1", "user", "USER REQUIREMENT"),
    message("a1", "assistant", [
      { type: "thinking", thinking: "discard me" },
      { type: "text", text: "VISIBLE ANSWER" },
      { type: "toolCall", id: "call-1", name: "read", arguments: {} },
    ]),
    message("t1", "toolResult", [{ type: "text", text: "discard tool output" }]),
    {
      type: "context_edit",
      id: "edit-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:02.000Z",
      targetId: "u1",
      replacement: { content: "EDITED REQUIREMENT" },
    },
  ]

  const preserved = preservedDialogueMessages(branch as any)
  assert.deepEqual(preserved.map((item: any) => item.role), ["user", "assistant"])
  assert.equal((preserved[0] as any).content, "EDITED REQUIREMENT")
  assert.deepEqual((preserved[1] as any).content, [{ type: "text", text: "VISIBLE ANSWER" }])
  assert.ok(!JSON.stringify(preserved).includes("discard me"))
  assert.ok(!JSON.stringify(preserved).includes("discard tool output"))
  assert.ok(!JSON.stringify(preserved).includes("call-1"))
})

test("compaction removes every pre-compaction tool/reasoning block even from Pi's kept tail", () => {
const branch = [
message("u1", "user", "MASTER REQUIREMENT"),
message("a1", "assistant", [
{ type: "thinking", thinking: "private analysis" },
{ type: "text", text: "VISIBLE RESPONSE" },
{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
]),
message("t1", "toolResult", [{ type: "text", text: "huge file output" }]),
message("keep", "user", "RECENT USER"),
message("a2", "assistant", [
{ type: "thinking", thinking: "recent hidden reasoning" },
{ type: "text", text: "RECENT RESPONSE" },
{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/recent.ts" } },
]),
message("t2", "toolResult", [{ type: "text", text: "recent kept tool output" }]),
// Native Pi would retain keep/a2/t2 because firstKeptEntryId is "keep".
// Preserve mode must not replay those old tools after compaction.
compaction("compact-1", "keep"),
]

const current = [
{ role: "compactionSummary", summary: "TOOL SUMMARY", tokensBefore: 1000, timestamp: 2 },
{ role: "user", content: "RECENT USER", timestamp: 3 },
{
role: "assistant",
content: [
{ type: "text", text: "RECENT RESPONSE" },
{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "src/recent.ts" } },
],
timestamp: 4,
},
{ role: "toolResult", content: [{ type: "text", text: "recent kept tool output" }], timestamp: 5 },
] as any[]

const rebuilt = rebuildPreservedDialogue(current as any, branch as any)!
assert.deepEqual(rebuilt.map((item: any) => item.role), [
"user",
"assistant",
"user",
"assistant",
"compactionSummary",
])
assert.equal((rebuilt[0] as any).content, "MASTER REQUIREMENT")
assert.deepEqual((rebuilt[1] as any).content, [{ type: "text", text: "VISIBLE RESPONSE" }])
assert.equal((rebuilt[2] as any).content, "RECENT USER")
assert.deepEqual((rebuilt[3] as any).content, [{ type: "text", text: "RECENT RESPONSE" }])
assert.equal((rebuilt[4] as any).summary, "TOOL SUMMARY")
assert.ok(!JSON.stringify(rebuilt).includes("huge file output"))
assert.ok(!JSON.stringify(rebuilt).includes("recent kept tool output"))
assert.ok(!JSON.stringify(rebuilt).includes("private analysis"))
assert.ok(!JSON.stringify(rebuilt).includes("recent hidden reasoning"))
assert.ok(!JSON.stringify(rebuilt).includes("call-1"))
assert.ok(!JSON.stringify(rebuilt).includes("call-2"))
})

test("tool traffic created after the latest compaction stays raw until the next compaction", () => {
const branch = [
message("u1", "user", "OLD USER"),
message("a1", "assistant", [{ type: "text", text: "OLD ANSWER" }]),
compaction("compact-1", "a1"),
message("u2", "user", "NEW USER"),
message("a2", "assistant", [
{ type: "text", text: "NEW ANSWER" },
{ type: "toolCall", id: "call-new", name: "read", arguments: { path: "new.ts" } },
]),
message("t2", "toolResult", [{ type: "text", text: "new tool output" }]),
]

const current = [
{ role: "compactionSummary", summary: "TOOLS", tokensBefore: 1000, timestamp: 2 },
{ role: "assistant", content: [{ type: "text", text: "OLD ANSWER" }], timestamp: 2 },
{ role: "user", content: "NEW USER", timestamp: 3 },
{
role: "assistant",
content: [
{ type: "text", text: "NEW ANSWER" },
{ type: "toolCall", id: "call-new", name: "read", arguments: { path: "new.ts" } },
],
timestamp: 4,
},
{ role: "toolResult", content: [{ type: "text", text: "new tool output" }], timestamp: 5 },
] as any[]

const rebuilt = rebuildPreservedDialogue(current as any, branch as any)!
assert.deepEqual(rebuilt.map((item: any) => item.role), [
"user",
"assistant",
"compactionSummary",
"user",
"assistant",
"toolResult",
])
assert.ok(JSON.stringify(rebuilt).includes("call-new"))
assert.ok(JSON.stringify(rebuilt).includes("new tool output"))
})

test("honors append-only context edits when restoring dialogue", () => {
  const branch = [
    message("u1", "user", "OLD PROMPT"),
    message("a1", "assistant", [{ type: "text", text: "ANSWER" }]),
    message("keep", "user", "RECENT"),
    compaction("compact-1", "keep"),
    {
      type: "context_edit",
      id: "edit-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:02.000Z",
      targetId: "u1",
      replacement: { content: "EDITED PROMPT" },
    },
  ]

  const current = [
    { role: "compactionSummary", summary: "TOOLS", tokensBefore: 1000, timestamp: 2 },
    { role: "user", content: "RECENT", timestamp: 3 },
  ] as any[]

  const rebuilt = rebuildPreservedDialogue(current as any, branch as any)!
  assert.equal((rebuilt[0] as any).content, "EDITED PROMPT")
})

test("latest preserve compaction restores dialogue across earlier compactions without duplicating summaries", () => {
  const branch = [
    message("u1", "user", "USER ONE"),
    message("a1", "assistant", [{ type: "text", text: "ANSWER ONE" }]),
    message("u2", "user", "USER TWO"),
    compaction("compact-1", "u2", "TOOLS ONE"),
    message("a2", "assistant", [{ type: "text", text: "ANSWER TWO" }]),
    message("u3", "user", "USER THREE"),
    compaction("compact-2", "u3", "TOOLS TWO"),
  ]

  const current = [
    { role: "compactionSummary", summary: "TOOLS TWO", tokensBefore: 2000, timestamp: 5 },
    { role: "user", content: "USER THREE", timestamp: 6 },
  ] as any[]

  const rebuilt = rebuildPreservedDialogue(current as any, branch as any)!
  assert.deepEqual(
    rebuilt.filter((item: any) => item.role === "user").map((item: any) => item.content),
    ["USER ONE", "USER TWO", "USER THREE"],
  )
  assert.deepEqual(
    rebuilt.filter((item: any) => item.role === "assistant").map((item: any) => item.content[0].text),
    ["ANSWER ONE", "ANSWER TWO"],
  )
  assert.equal(rebuilt.filter((item: any) => item.role === "compactionSummary").length, 1)
  assert.equal((rebuilt.find((item: any) => item.role === "compactionSummary") as any).summary, "TOOLS TWO")
})

test("does nothing when the latest compaction is not preserve-dialogue", () => {
  const branch = [
    message("u1", "user", "OLD"),
    message("keep", "user", "RECENT"),
    compaction("compact-old", "keep", "OLD TOOL SUMMARY"),
    compaction("compact-native", "keep", "NORMAL SUMMARY", false),
  ]
  const current = [{ role: "compactionSummary", summary: "NORMAL SUMMARY", tokensBefore: 10, timestamp: 1 }] as any[]
  assert.equal(rebuildPreservedDialogue(current as any, branch as any), undefined)
})
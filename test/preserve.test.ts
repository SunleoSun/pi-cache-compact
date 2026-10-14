import { test } from "node:test"
import assert from "node:assert/strict"

import {
  PRESERVE_DIALOGUE_CHECKPOINT_TYPE,
  PRESERVE_DIALOGUE_MARKER,
  preserveDeltaScope,
  preserveDialogueBoundaryEntries,
  preserveDialogueStates,
  preservedDialogueMessages,
  previewPreservedContextAfterCheckpoint,
  rebuildPreservedDialogue,
} from "../src/preserve.ts"

function message(id: string, role: string, content: unknown, stopReason?: string): any {
return {
type: "message",
id,
parentId: null,
timestamp: "2026-01-01T00:00:00.000Z",
message: {
role,
content,
timestamp: 1,
...(role === "assistant" ? { stopReason: stopReason ?? "stop" } : {}),
},
}
}

function compaction(
  id: string,
  firstKeptEntryId: string,
  summary = "TOOL SUMMARY",
  preserve = true,
): any {
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

test("preservedDialogueMessages keeps only user messages and completed assistant replies", () => {
const branch = [
message("u1", "user", "USER REQUIREMENT"),
message(
"a1",
"assistant",
[
{ type: "thinking", thinking: "discard me" },
{ type: "text", text: "INTERMEDIATE TOOL PROSE" },
{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
],
"toolUse",
),
message("t1", "toolResult", [{ type: "text", text: "discard tool output" }]),
message("a2", "assistant", [
{ type: "thinking", thinking: "discard final thinking" },
{ type: "text", text: "FINAL ANSWER" },
]),
message("a3", "assistant", [{ type: "text", text: "TRUNCATED ANSWER" }], "length"),
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
assert.deepEqual(
preserved.map((item: any) => item.role),
["user", "assistant"],
)
assert.equal((preserved[0] as any).content, "EDITED REQUIREMENT")
assert.deepEqual((preserved[1] as any).content, [{ type: "text", text: "FINAL ANSWER" }])
const serialized = JSON.stringify(preserved)
assert.ok(!serialized.includes("INTERMEDIATE TOOL PROSE"))
assert.ok(!serialized.includes("discard me"))
assert.ok(!serialized.includes("discard final thinking"))
assert.ok(!serialized.includes("discard tool output"))
assert.ok(!serialized.includes("TRUNCATED ANSWER"))
assert.ok(!serialized.includes("call-1"))
})

test("turn-boundary preserve checkpoint hides tool state from the model without emitting a Pi compaction", () => {
  const branch = [
    message("u1", "user", "USER"),
    message(
    "a1",
    "assistant",
    [
    { type: "thinking", thinking: "discard reasoning" },
    { type: "text", text: "VISIBLE" },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "x.ts" } },
    ],
    "toolUse",
    ),
    message("t1", "toolResult", [{ type: "text", text: "RAW TOOL OUTPUT" }]),
  ]

  const drafts = preserveDialogueBoundaryEntries({
    branchEntries: branch as any,
    summary: "TECHNICAL CHECKPOINT",
    tokensBefore: 1234,
    details: { cacheCompact: PRESERVE_DIALOGUE_MARKER },
  })

  assert.equal(
    drafts.some((entry: any) => entry.type === "compaction"),
    false,
  )
  assert.equal(
  (drafts.find((entry: any) => entry.type === "context_edit" && entry.targetId === "a1") as any)
  ?.replacement,
  null,
  )
  assert.equal(
    (drafts.find((entry: any) => entry.type === "context_edit" && entry.targetId === "t1") as any)
      ?.replacement,
    null,
  )
  const checkpoint = drafts.at(-1) as any
  assert.equal(checkpoint.type, "custom_message")
  assert.equal(checkpoint.customType, PRESERVE_DIALOGUE_CHECKPOINT_TYPE)
  assert.equal(checkpoint.display, false)
  assert.equal(checkpoint.details.checkpoint.summary, "TECHNICAL CHECKPOINT")
})

test("preserveDeltaScope separates multiple user requests and records raw branch boundaries", () => {
  const branch = [
    message("u1", "user", "FIRST REQUEST"),
    message("a1", "assistant", [
      { type: "text", text: "FIRST VISIBLE" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "first.ts" } },
    ]),
    message("t1", "toolResult", [{ type: "text", text: "FIRST RESULT" }]),
    message("u2", "user", "SECOND REQUEST"),
    message("a2", "assistant", [
      { type: "thinking", thinking: "discard" },
      { type: "toolCall", id: "call-2", name: "read", arguments: { path: "second.ts" } },
    ]),
    message("t2", "toolResult", [{ type: "text", text: "SECOND RESULT" }]),
  ]

  const scope = preserveDeltaScope(branch as any)
  assert.deepEqual(scope.coveredUserMessages, [1, 2])
  assert.deepEqual(scope.rawEntryIds, ["a1", "t1", "a2", "t2"])
  assert.equal(scope.firstRawEntryId, "a1")
  assert.equal(scope.lastRawEntryId, "t2")
  assert.equal(scope.rawEntryCount, 4)
})
test("preserveDeltaScope treats non-final assistant text as raw technical state", () => {
  const branch = [
    message("u1", "user", "REQUEST"),
    message("a1", "assistant", [{ type: "text", text: "TRUNCATED ANSWER" }], "length"),
  ]

  const scope = preserveDeltaScope(branch as any)
  assert.deepEqual(scope.rawEntryIds, ["a1"])
  assert.equal(scope.rawEntryCount, 1)
  assert.deepEqual(scope.coveredUserMessages, [])
})

test("a repeated turn-boundary checkpoint appends a new immutable checkpoint and keeps the newest batch raw", () => {
  const priorCheckpoint = {
    type: "custom_message",
    id: "checkpoint-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:03.000Z",
    customType: PRESERVE_DIALOGUE_CHECKPOINT_TYPE,
    content: "## Tool Context Checkpoint\n\nOLD CHECKPOINT",
    display: false,
    details: {
      cacheCompact: PRESERVE_DIALOGUE_MARKER,
      checkpoint: { summary: "OLD CHECKPOINT", tokensBefore: 1000 },
    },
  }
  const branch = [
    message("u1", "user", "OLD USER"),
    message("a1", "assistant", [{ type: "text", text: "OLD ANSWER" }]),
    message("t1", "toolResult", [{ type: "text", text: "OLD RAW TOOL" }]),
    priorCheckpoint,
    message("a2", "assistant", [
      { type: "text", text: "MIDDLE ANSWER" },
      { type: "toolCall", id: "call-2", name: "read", arguments: { path: "middle.ts" } },
    ]),
    message("t2", "toolResult", [{ type: "text", text: "MIDDLE RAW TOOL" }]),
    message("a3", "assistant", [
      { type: "text", text: "NEWEST ANSWER" },
      { type: "toolCall", id: "call-3", name: "read", arguments: { path: "newest.ts" } },
    ]),
    message("t3", "toolResult", [{ type: "text", text: "NEWEST RAW TOOL" }]),
  ]
  const sameUserScope = preserveDeltaScope(branch as any, "a3")
  assert.deepEqual(sameUserScope.coveredUserMessages, [1])
  assert.deepEqual(sameUserScope.rawEntryIds, ["a2", "t2"])

  const drafts = preserveDialogueBoundaryEntries({
    branchEntries: branch as any,
    summary: "NEW CHECKPOINT",
    tokensBefore: 2000,
    details: { cacheCompact: PRESERVE_DIALOGUE_MARKER },
    rawTailStartEntryId: "a3",
  })

  assert.equal(
    drafts.some((entry: any) => entry.targetId === "checkpoint-1"),
    false,
  )
  assert.equal(
    drafts.some((entry: any) => entry.targetId === "t1"),
    false,
  )
  assert.equal(
    drafts.some((entry: any) => entry.targetId === "a1"),
    false,
  )
  assert.equal(
    drafts.some((entry: any) => entry.targetId === "t2" && entry.replacement === null),
    true,
  )
  assert.equal(
    drafts.some((entry: any) => entry.targetId === "a3"),
    false,
  )
  assert.equal(
    drafts.some((entry: any) => entry.targetId === "t3"),
    false,
  )

  const next = drafts.at(-1) as any
  assert.equal(next.details.checkpoint.summary, "NEW CHECKPOINT")
  assert.equal(next.details.checkpoint.number, 2)
  assert.deepEqual(next.details.checkpoint.coveredUserMessages, [1])
  assert.equal(next.details.checkpoint.rawTailStartEntryId, "a3")
  assert.match(next.content, /Tool Context Checkpoint #2/)

  const withNext = [
    ...branch,
    { ...next, id: "checkpoint-2", timestamp: "2026-01-01T00:00:06.000Z" },
  ] as any
  assert.deepEqual(
    preserveDialogueStates(withNext).map((state) => state.summary),
    ["OLD CHECKPOINT", "NEW CHECKPOINT"],
  )
  assert.deepEqual(preserveDeltaScope(withNext).coveredUserMessages, [1])

  const rebuilt = rebuildPreservedDialogue([], withNext)!
  assert.deepEqual(
    rebuilt.filter((item: any) => item.role === "custom").map((item: any) => item.content),
    [priorCheckpoint.content, next.content],
  )
  assert.ok(!JSON.stringify(rebuilt).includes("MIDDLE RAW TOOL"))
  assert.ok(JSON.stringify(rebuilt).includes("NEWEST RAW TOOL"))
  const projectedNextCheckpoint = rebuilt.find(
    (item: any) => item.role === "custom" && item.content === next.content,
  ) as any
  const projectedRawTailAssistant = rebuilt.find(
    (item: any) =>
      item.role === "assistant" &&
      Array.isArray(item.content) &&
      item.content.some((block: any) => block.type === "toolCall" && block.id === "call-3"),
  ) as any
  assert.ok(projectedNextCheckpoint.timestamp > projectedRawTailAssistant.timestamp)

  const preview = previewPreservedContextAfterCheckpoint({
    branchEntries: branch as any,
    summary: "PREVIEW CHECKPOINT",
    tokensBefore: 2000,
    details: { cacheCompact: PRESERVE_DIALOGUE_MARKER },
    rawTailStartEntryId: "a3",
  })
  const previewCheckpoint = preview.find(
    (item: any) => item.role === "custom" && String(item.content).includes("PREVIEW CHECKPOINT"),
  ) as any
  const previewRawTailAssistant = preview.find(
    (item: any) =>
      item.role === "assistant" &&
      Array.isArray(item.content) &&
      item.content.some((block: any) => block.type === "toolCall" && block.id === "call-3"),
  ) as any
  assert.ok(previewCheckpoint.timestamp > previewRawTailAssistant.timestamp)
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
    {
      role: "toolResult",
      content: [{ type: "text", text: "recent kept tool output" }],
      timestamp: 5,
    },
  ] as any[]

  const rebuilt = rebuildPreservedDialogue(current as any, branch as any)!
  assert.deepEqual(
  rebuilt.map((item: any) => item.role),
  ["user", "user", "compactionSummary"],
  )
  assert.equal((rebuilt[0] as any).content, "MASTER REQUIREMENT")
  assert.equal((rebuilt[1] as any).content, "RECENT USER")
  assert.equal((rebuilt[2] as any).summary, "TOOL SUMMARY")
  assert.ok(!JSON.stringify(rebuilt).includes("VISIBLE RESPONSE"))
  assert.ok(!JSON.stringify(rebuilt).includes("RECENT RESPONSE"))
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
  assert.deepEqual(
    rebuilt.map((item: any) => item.role),
    ["user", "assistant", "compactionSummary", "user", "assistant", "toolResult"],
  )
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

test("modern manual preserve compaction retains earlier immutable checkpoints", () => {
  const priorDetails = {
    cacheCompact: PRESERVE_DIALOGUE_MARKER,
    checkpoint: {
      summary: "OLD CHECKPOINT",
      tokensBefore: 1000,
      number: 1,
      coveredUserMessages: [1],
    },
  }
  const manualDetails = {
    cacheCompact: PRESERVE_DIALOGUE_MARKER,
    checkpoint: {
      summary: "MANUAL CHECKPOINT",
      tokensBefore: 2000,
      number: 2,
      coveredUserMessages: [2],
    },
  }
  const priorCheckpoint = {
    type: "custom_message",
    id: "checkpoint-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    customType: PRESERVE_DIALOGUE_CHECKPOINT_TYPE,
    content: "## Tool Context Checkpoint #1\n\nOLD CHECKPOINT",
    display: false,
    details: priorDetails,
  }
  const manualCompaction = {
    type: "compaction",
    id: "compact-2",
    parentId: null,
    timestamp: "2026-01-01T00:00:03.000Z",
    summary: "MANUAL CHECKPOINT",
    firstKeptEntryId: "u1",
    tokensBefore: 2000,
    details: manualDetails,
    systemMessage: { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
  }
  const branch = [
    message("u1", "user", "USER ONE"),
    priorCheckpoint,
    message("u2", "user", "USER TWO"),
    manualCompaction,
  ] as any

  assert.deepEqual(
    preserveDialogueStates(branch).map((state) => state.summary),
    ["OLD CHECKPOINT", "MANUAL CHECKPOINT"],
  )
  const rebuilt = rebuildPreservedDialogue([], branch)!
  assert.deepEqual(
    rebuilt.filter((item: any) => item.role === "user").map((item: any) => item.content),
    ["USER ONE", "USER TWO"],
  )
  assert.equal(
    rebuilt.filter(
      (item: any) =>
        item.role === "custom" && String(item.content).includes("OLD CHECKPOINT"),
    ).length,
    1,
  )
  assert.equal(
    rebuilt.filter(
      (item: any) =>
        item.role === "compactionSummary" && item.summary === "MANUAL CHECKPOINT",
    ).length,
    1,
  )
  assert.equal(rebuilt.filter((item: any) => item.role === "system").length, 0)
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
    rebuilt
      .filter((item: any) => item.role === "assistant")
      .map((item: any) => item.content[0].text),
    ["ANSWER ONE", "ANSWER TWO"],
  )
  assert.equal(rebuilt.filter((item: any) => item.role === "compactionSummary").length, 1)
  assert.equal(
    (rebuilt.find((item: any) => item.role === "compactionSummary") as any).summary,
    "TOOLS TWO",
  )
})

test("does nothing when the latest compaction is not preserve-dialogue", () => {
  const branch = [
    message("u1", "user", "OLD"),
    message("keep", "user", "RECENT"),
    compaction("compact-old", "keep", "OLD TOOL SUMMARY"),
    compaction("compact-native", "keep", "NORMAL SUMMARY", false),
  ]
  const current = [
    { role: "compactionSummary", summary: "NORMAL SUMMARY", tokensBefore: 10, timestamp: 1 },
  ] as any[]
  assert.equal(rebuildPreservedDialogue(current as any, branch as any), undefined)
})

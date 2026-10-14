import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { SettingsManager } from "@earendil-works/pi-coding-agent"
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent"
import type { AssistantMessage } from "@earendil-works/pi-ai"

import cacheCompact from "../src/extension.ts"

type Calls = {
  complete: Array<{ model: any; context: any; options: any }>
  compact: any[]
  notifications: Array<{ message: string; type: string | undefined }>
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "test-model",
    usage: { input: 1, output: 1, cacheRead: 5, cacheWrite: 2, totalTokens: 2, cost: {} } as any,
    stopReason,
    timestamp: Date.now(),
  }
}

function setup(config?: {
  response?: AssistantMessage | (() => Promise<AssistantMessage>)
  tools?: any[]
  activeTools?: string[]
  systemPrompt?: string
  messages?: any[]
  entries?: any[]
  branchEntries?: any[]
  // The summarizer's model shape is mirrored here; `contextWindow` drives the
  // continuation guard, so tests can make it too small to fit.
  model?: { provider: string; id: string; contextWindow?: number }
  foundModel?: any
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }
  hasUI?: boolean
  cwd?: string
  agentDir?: string
}) {
  const handlers = new Map<string, Function>()
  const calls: Calls = { complete: [], compact: [], notifications: [] }
  const api = {
    on: (event: string, handler: Function) => {
      handlers.set(event, handler)
      return () => {}
    },
    getAllTools: () =>
      config?.tools ?? [
        { name: "read", description: "read", parameters: { type: "object" }, sourceInfo: {} },
      ],
    getActiveTools: () => config?.activeTools ?? ["read"],
  } as unknown as ExtensionAPI

  const respond = async (): Promise<AssistantMessage> => {
    const response = config?.response
    if (typeof response === "function") return response()
    return response ?? assistant([{ type: "text", text: "MOCK SUMMARY" }])
  }

  const ctx = {
    cwd: config?.cwd ?? process.cwd(),
    hasUI: config?.hasUI ?? false,
    isProjectTrusted: () => true,
    ui: {
      notify: (message: string, type?: string) => {
        calls.notifications.push({ message, type })
      },
    },
    model: config?.model ?? { provider: "mock", id: "test-model" },
    getSystemPrompt: () => config?.systemPrompt ?? "SYSTEM PROMPT",
    sessionManager: {
      getBranch: () => config?.branchEntries ?? [],
      buildSessionProjection: () => ({
        messages: config?.messages ?? [
          { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
          { role: "user", content: "hello from the session", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
          { role: "user", content: "recent kept message", timestamp: 3 },
        ],
        entries: config?.entries ?? [
          {
            sourceEntry: { id: "sys" },
            messages: [{ role: "system", content: "SYSTEM PROMPT", timestamp: 0 }],
          },
          {
            sourceEntry: { id: "u1" },
            messages: [{ role: "user", content: "hello from the session", timestamp: 1 }],
          },
          {
            sourceEntry: { id: "a1" },
            messages: [
              { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
            ],
          },
          {
            sourceEntry: { id: "keep-1" },
            messages: [{ role: "user", content: "recent kept message", timestamp: 3 }],
          },
        ],
        thinkingLevel: "off",
        model: null,
      }),
      getSessionId: () => "sess-1",
    },
    getContextUsage: () => config?.contextUsage,
    compact: (options: any) => {
      calls.compact.push(options)
    },
    modelRegistry: {
      find: () => config?.foundModel,
      complete: async (model: any, context: any, options: any) => {
        calls.complete.push({ model, context, options })
        // Mimic pi-ai: hand the assembled params to onPayload before sending.
        if (typeof options?.onPayload === "function") {
          await options.onPayload({
            model: model?.id ?? "m",
            stream: true,
            tools: [{ type: "function", function: { name: "read" } }],
            messages: context.messages,
          })
        }
        // ...and the response headers to onResponse once "the wire" answers.
        if (typeof options?.onResponse === "function") {
          await options.onResponse(
            { status: 200, headers: { "x-replica": "mock-1", "set-cookie": "session=secret" } },
            model,
          )
        }
        return respond()
      },
    },
  } as unknown as ExtensionContext

  cacheCompact(api)
  const handler = handlers.get("session_before_compact")!
  const providerHandler = handlers.get("before_provider_request")!
  return { handler, providerHandler, ctx, calls, handlers }
}

function event(overrides: Partial<SessionBeforeCompactEvent> = {}): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: { firstKeptEntryId: "keep-1", tokensBefore: 1234 } as any,
    branchEntries: [],
    customInstructions: undefined,
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
    ...overrides,
  }
}

function preserveEvent(overrides: Record<string, unknown> = {}): SessionBeforeCompactEvent {
  return event({
    ...overrides,
    preserveTailStartEntryId:
      typeof overrides.preserveTailStartEntryId === "string"
        ? overrides.preserveTailStartEntryId
        : "keep-1",
    preserveTailMessageCount:
      typeof overrides.preserveTailMessageCount === "number"
        ? overrides.preserveTailMessageCount
        : 1,
  } as any)
}

function tempWorkspace(config?: unknown): { cwd: string; agentDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cache-compact-ext-"))
  const cwd = path.join(root, "project")
  const agentDir = path.join(root, "agent")
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  const effectiveConfig =
    config && typeof config === "object" && !Array.isArray(config)
      ? { preserveDialogue: false, ...(config as Record<string, unknown>) }
      : { preserveDialogue: false }
  fs.writeFileSync(path.join(cwd, ".pi", "cache-compact.json"), JSON.stringify(effectiveConfig))
  return { cwd, agentDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

test("certification: preserve mode disables Pi native compaction in memory", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  fs.writeFileSync(
    path.join(ws.agentDir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    }),
  )
  try {
    const model = { provider: "mock", id: "test-model", contextWindow: 50_000 }
    const { handlers, ctx } = setup({ cwd: ws.cwd, agentDir: ws.agentDir, model })

    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx)

    const manager = SettingsManager.create(ws.cwd, ws.agentDir, { projectTrusted: true })
    const during = manager.getCompactionSettings(model as any)
    assert.equal(during.enabled, false)
    assert.equal(during.reserveTokens, 16_384)
    assert.equal(during.keepRecentTokens, 1)

    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx)
    const afterShutdown = SettingsManager.create(ws.cwd, ws.agentDir, { projectTrusted: true })
    const restored = afterShutdown.getCompactionSettings(model as any)
    assert.equal(restored.enabled, true)
    assert.equal(restored.keepRecentTokens, 20_000)
  } finally {
    ws.cleanup()
  }
})

test("writes a summary as a forward continuation of the live conversation", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({ cwd: ws.cwd })
    const result = (await handler(preserveEvent(), ctx)) as any

    assert.equal(result.compaction.summary, "MOCK SUMMARY")
    assert.equal(result.compaction.firstKeptEntryId, "keep-1")
    assert.equal(result.compaction.tokensBefore, 1234)
    assert.equal(result.compaction.usage.cacheRead, 5)

    assert.equal(calls.complete.length, 1)
    const { context, options } = calls.complete[0]
    // The projection's leading system message is reused as-is, so no synthetic
    // prompt/tools and no doubled system message.
    assert.equal(context.systemPrompt, "")
    assert.deepEqual(context.tools, [])
    // The whole live message list (system, user, assistant, kept tail) + ask:
    // the request must be a forward continuation of the live request the server
    // has cached, not a rewind to the dropped span. Measured on llama.cpp, a
    // request 35 tokens shorter than the checkpoint re-prefilled all 7710
    // tokens, while a continuation reused 7706/7745 in 0.4 s.
    assert.equal(context.messages.length, 5)
    assert.equal(context.messages[0].role, "system")
    assert.equal(context.messages[1].content, "hello from the session")
    assert.equal(context.messages.at(-2).content, "recent kept message")
    assert.equal(context.messages.at(-1).role, "user")
    const askText = context.messages.at(-1).content[0].text
    assert.match(askText, /structured context checkpoint summary/i)
    // ...but the kept tail must stay out of the summary *text*, or the summary
    // would describe messages that Pi keeps verbatim a second time.
    assert.match(askText, /1 later message\(s\) stay in the context verbatim/)
    assert.match(askText, /assistant message that begins/)
    assert.match(askText, /"hi"/)
    assert.equal(options.toolChoice, "none")
    assert.equal(options.cacheRetention, "short")
  } finally {
    ws.cleanup()
  }
})

test("preserveDialogue compacts older tool state when the newest tool batch enters reserve", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const branchEntries = [
      {
        type: "message",
        id: "u1",
        message: { role: "user", content: "PERMANENT USER REQUIREMENT", timestamp: 1 },
      },
      {
        type: "message",
        id: "a-old",
        message: assistant(
        [
        { type: "thinking", thinking: "old reasoning" },
        { type: "text", text: "PERMANENT OLD ANSWER" },
        { type: "toolCall", id: "call-old", name: "read", arguments: {} },
        ] as any,
        "toolUse",
        ),
      },
      {
        type: "message",
        id: "t-old",
        message: {
          role: "toolResult",
          toolCallId: "call-old",
          toolName: "read",
          content: [{ type: "text", text: "OLD TOOL OUTPUT".repeat(500) }],
          isError: false,
          timestamp: 3,
        },
      },
      {
        type: "message",
        id: "a-latest",
        message: assistant(
        [
        { type: "text", text: "PERMANENT LATEST ANSWER" },
        { type: "toolCall", id: "call-latest", name: "read", arguments: {} },
        ] as any,
        "toolUse",
        ),
      },
      {
        type: "message",
        id: "t-latest",
        message: {
          role: "toolResult",
          toolCallId: "call-latest",
          toolName: "read",
          content: [{ type: "text", text: "LATEST TOOL OUTPUT".repeat(1000) }],
          isError: false,
          timestamp: 5,
        },
      },
    ]
    const messages = [
      { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
      ...branchEntries.map((entry: any) => entry.message),
    ]
    const { handlers, ctx, calls } = setup({
      cwd: ws.cwd,
      branchEntries,
      messages,
      contextUsage: { tokens: 87_026, contextWindow: 100_000, percent: 87.026 },
      model: { provider: "mock", id: "test-model", contextWindow: 100_000 },
    })

    const result = await handlers.get("turn_end")!(
      {
        type: "turn_end",
        turnIndex: 1,
        message: branchEntries[3].message,
        toolResults: [branchEntries[4].message],
        messageEntryId: "a-latest",
        toolResultEntryIds: ["t-latest"],
        entries: [],
        continue: false,
      },
      ctx,
    )

    assert.equal(calls.compact.length, 0, "preserve compaction must not call ctx.compact()")
    assert.equal(calls.complete.length, 1)
    assert.equal(
      result.entries.some((entry: any) => entry.type === "compaction"),
      false,
    )
    const oldAssistantEdit = result.entries.find(
      (entry: any) => entry.type === "context_edit" && entry.targetId === "a-old",
    )
    const oldToolEdit = result.entries.find(
      (entry: any) => entry.type === "context_edit" && entry.targetId === "t-old",
    )
    assert.equal(oldAssistantEdit.replacement, null)
    assert.equal(oldToolEdit.replacement, null)
    assert.equal(
      result.entries.some(
        (entry: any) => entry.type === "context_edit" && entry.targetId === "a-latest",
      ),
      false,
    )
    assert.equal(
      result.entries.some(
        (entry: any) => entry.type === "context_edit" && entry.targetId === "t-latest",
      ),
      false,
    )
    const checkpoint = result.entries.at(-1)
    assert.equal(checkpoint.customType, "cache-compact-preserve-checkpoint")
    const summaryRequest = JSON.stringify(calls.complete[0].context.messages)
    assert.match(summaryRequest, /OLD TOOL OUTPUT/)
    assert.doesNotMatch(summaryRequest, /LATEST TOOL OUTPUT/)
  } finally {
    ws.cleanup()
  }
})

test("certification: a latest tool batch crossing the fitted 50k reserve triggers before the next request", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const branchEntries = [
      { type: "message", id: "u1", message: { role: "user", content: "KEEP USER", timestamp: 1 } },
      {
        type: "message",
        id: "a-old",
        message: assistant([
          { type: "text", text: "KEEP OLD ANSWER" },
          { type: "toolCall", id: "call-old", name: "read", arguments: {} },
        ] as any),
      },
      {
        type: "message",
        id: "t-old",
        message: {
          role: "toolResult",
          toolCallId: "call-old",
          toolName: "read",
          content: [{ type: "text", text: "old compactable state".repeat(200) }],
          isError: false,
          timestamp: 3,
        },
      },
      {
        type: "message",
        id: "a-latest",
        message: assistant([
          { type: "text", text: "KEEP LATEST ANSWER" },
          { type: "toolCall", id: "call-latest", name: "read", arguments: {} },
        ] as any),
      },
      {
        type: "message",
        id: "t-latest",
        message: {
          role: "toolResult",
          toolCallId: "call-latest",
          toolName: "read",
          content: [{ type: "text", text: "latest raw state".repeat(1000) }],
          isError: false,
          timestamp: 5,
        },
      },
    ]
    const { handlers, ctx, calls } = setup({
      cwd: ws.cwd,
      branchEntries,
      messages: [
        { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
        ...branchEntries.map((entry: any) => entry.message),
      ],
      contextUsage: { tokens: 41_114, contextWindow: 50_000, percent: 82.228 },
      model: { provider: "mock", id: "test-model", contextWindow: 50_000 },
      hasUI: true,
    })

    const result = await handlers.get("turn_end")!(
      {
        type: "turn_end",
        turnIndex: 1,
        message: branchEntries[3].message,
        toolResults: [branchEntries[4].message],
        messageEntryId: "a-latest",
        toolResultEntryIds: ["t-latest"],
        entries: [],
        continue: false,
      },
      ctx,
    )

    assert.equal(calls.complete.length, 1)
    assert.equal(
      result.entries.some((entry: any) => entry.type === "compaction"),
      false,
    )
    assert.equal(result.entries.at(-1).customType, "cache-compact-preserve-checkpoint")
    assert.match(calls.notifications.at(-1)!.message, /reserve threshold/)
    assert.ok(calls.complete[0].options.maxTokens > 0)
    assert.ok(calls.complete[0].options.maxTokens <= 8_886)
  } finally {
    ws.cleanup()
  }
})

test("certification: a 500k preserve window uses the fitted 29,575-token reserve", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const branchEntries = [
      { type: "message", id: "u1", message: { role: "user", content: "KEEP USER", timestamp: 1 } },
      {
        type: "message",
        id: "a-old",
        message: assistant([
          { type: "text", text: "KEEP OLD ANSWER" },
          { type: "toolCall", id: "call-old", name: "read", arguments: {} },
        ] as any),
      },
      {
        type: "message",
        id: "t-old",
        message: {
          role: "toolResult",
          toolCallId: "call-old",
          toolName: "read",
          content: [{ type: "text", text: "old state".repeat(500) }],
          isError: false,
          timestamp: 3,
        },
      },
      {
        type: "message",
        id: "a-latest",
        message: assistant([
          { type: "text", text: "KEEP LATEST ANSWER" },
          { type: "toolCall", id: "call-latest", name: "read", arguments: {} },
        ] as any),
      },
      {
        type: "message",
        id: "t-latest",
        message: {
          role: "toolResult",
          toolCallId: "call-latest",
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(100_000) }],
          isError: false,
          timestamp: 5,
        },
      },
    ]
    const { handlers, ctx, calls } = setup({
      cwd: ws.cwd,
      branchEntries,
      messages: [
        { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
        ...branchEntries.map((entry: any) => entry.message),
      ],
      contextUsage: { tokens: 470_425, contextWindow: 500_000, percent: 94.085 },
      model: { provider: "mock", id: "test-model", contextWindow: 500_000 },
      hasUI: true,
    })

    const result = await handlers.get("turn_end")!(
      {
        type: "turn_end",
        turnIndex: 1,
        message: branchEntries[3].message,
        toolResults: [branchEntries[4].message],
        messageEntryId: "a-latest",
        toolResultEntryIds: ["t-latest"],
        entries: [],
        continue: false,
      },
      ctx,
    )

    assert.equal(calls.complete.length, 1)
    assert.ok(calls.complete[0].options.maxTokens > 0)
    assert.ok(calls.complete[0].options.maxTokens <= 29_575)
    assert.equal(result.entries.at(-1).customType, "cache-compact-preserve-checkpoint")
    assert.ok(calls.notifications.some((notice) => /reserve threshold/.test(notice.message)))
  } finally {
    ws.cleanup()
  }
})
test("preserveDialogue never proactively compacts a tool-free final turn", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const assistantMessage = assistant([
      { type: "thinking", thinking: "compressible reasoning".repeat(500) },
      { type: "text", text: "PERMANENT VISIBLE ANSWER" },
    ] as any)
    const branchEntries = [
      {
        type: "message",
        id: "u1",
        message: { role: "user", content: "PERMANENT USER REQUIREMENT", timestamp: 1 },
      },
      { type: "message", id: "a1", message: assistantMessage },
    ]
    const { handlers, ctx, calls } = setup({
      cwd: ws.cwd,
      branchEntries,
      messages: [
        { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
        branchEntries[0].message,
        branchEntries[1].message,
      ],
      contextUsage: { tokens: 92_000, contextWindow: 100_000, percent: 92 },
      model: { provider: "mock", id: "test-model", contextWindow: 100_000 },
    })

    const result = await handlers.get("turn_end")!(
      {
        type: "turn_end",
        turnIndex: 0,
        message: assistantMessage,
        toolResults: [],
        messageEntryId: "a1",
        toolResultEntryIds: [],
        entries: [],
        continue: false,
      },
      ctx,
    )

    assert.equal(result, undefined)
    assert.equal(calls.complete.length, 0)
    assert.equal(calls.compact.length, 0)
  } finally {
    ws.cleanup()
  }
})

test("preserveDialogue compacts older raw state after a tool-free length turn", async () => {
const ws = tempWorkspace({ preserveDialogue: true })
process.env.PI_CODING_AGENT_DIR = ws.agentDir
try {
const oldAssistant = assistant(
[
{ type: "text", text: "INTERMEDIATE TOOL TEXT" },
{ type: "toolCall", id: "call-old", name: "read", arguments: {} },
] as any,
"toolUse",
)
const oldResult = {
role: "toolResult",
toolCallId: "call-old",
toolName: "read",
content: [{ type: "text", text: "CARRIED RAW RESULT".repeat(300) }],
isError: false,
timestamp: 3,
}
const currentAssistant = {
...assistant(
[{ type: "thinking", thinking: "CURRENT TRUNCATED REASONING" }] as any,
"length",
),
usage: {
input: 56_172,
output: 1,
cacheRead: 0,
cacheWrite: 0,
reasoning: 1,
totalTokens: 56_173,
cost: {},
},
}
const branchEntries = [
{
type: "message",
id: "u1",
message: { role: "user", content: "PERMANENT USER REQUIREMENT", timestamp: 1 },
},
{ type: "message", id: "a-old", message: oldAssistant },
{ type: "message", id: "t-old", message: oldResult },
{ type: "message", id: "a-current", message: currentAssistant },
]
const { handlers, ctx, calls } = setup({
cwd: ws.cwd,
branchEntries,
messages: [
{ role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
branchEntries[0].message,
oldAssistant,
oldResult,
currentAssistant,
],
contextUsage: { tokens: 56_173, contextWindow: 50_000, percent: 112.346 },
model: { provider: "mock", id: "test-model", contextWindow: 50_000 },
hasUI: true,
})

const result = await handlers.get("turn_end")!(
{
type: "turn_end",
turnIndex: 2,
message: currentAssistant,
toolResults: [],
messageEntryId: "a-current",
toolResultEntryIds: [],
entries: [],
continue: false,
},
ctx,
)

assert.equal(calls.complete.length, 1)
const summaryRequest = JSON.stringify(calls.complete[0].context.messages)
assert.match(summaryRequest, /CARRIED RAW RESULT/)
assert.doesNotMatch(summaryRequest, /CURRENT TRUNCATED REASONING/)
assert.match(summaryRequest, /Summarize the supplied technical context/)
assert.equal(calls.complete[0].context.messages[0].role, "system")
assert.ok(
result.entries.some(
(entry: any) => entry.type === "context_edit" && entry.targetId === "t-old",
),
)
assert.equal(
result.entries.some(
(entry: any) => entry.type === "context_edit" && entry.targetId === "a-current",
),
false,
)
assert.equal(result.entries.at(-1).customType, "cache-compact-preserve-checkpoint")
assert.match(
calls.notifications.find((notice) => /compact complete/.test(notice.message))!.message,
 /newest raw kept: ~[1-9]\d* tok/,
)
} finally {
ws.cleanup()
}
})

test("preserveDialogue reports reserve-threshold compaction and keeps the newest tool batch raw", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const branchEntries = [
      {
        type: "message",
        id: "u1",
        message: { role: "user", content: "PERMANENT USER REQUIREMENT", timestamp: 1 },
      },
      {
        type: "message",
        id: "a-old",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "PERMANENT OLD ANSWER" },
            { type: "toolCall", id: "call-old", name: "read", arguments: {} },
          ],
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "t-old",
        message: {
          role: "toolResult",
          toolCallId: "call-old",
          toolName: "read",
          content: [{ type: "text", text: "OLD COMPACTABLE RESULT".repeat(200) }],
          isError: false,
          timestamp: 3,
        },
      },
      {
        type: "message",
        id: "a-latest",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "PERMANENT LATEST ANSWER" },
            { type: "toolCall", id: "call-latest", name: "read", arguments: {} },
          ],
          timestamp: 4,
        },
      },
      {
        type: "message",
        id: "t-latest",
        message: {
          role: "toolResult",
          toolCallId: "call-latest",
          toolName: "read",
          content: [{ type: "text", text: "LATEST RAW RESULT".repeat(1000) }],
          isError: false,
          timestamp: 5,
        },
      },
    ]
    const messages = [
      { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
      ...branchEntries.map((entry: any) => entry.message),
    ]
    const { handlers, ctx, calls } = setup({
      cwd: ws.cwd,
      hasUI: true,
      branchEntries,
      messages,
      contextUsage: { tokens: 87_026, contextWindow: 100_000, percent: 87.026 },
      model: { provider: "mock", id: "test-model", contextWindow: 100_000 },
    })

    const result = await handlers.get("turn_end")!(
      {
        type: "turn_end",
        turnIndex: 1,
        message: branchEntries[3].message,
        toolResults: [branchEntries[4].message],
        messageEntryId: "a-latest",
        toolResultEntryIds: ["t-latest"],
        entries: [],
        continue: false,
      },
      ctx,
    )

    assert.equal(result.entries.at(-1).type, "custom_message")
    assert.equal(calls.compact.length, 0)
    assert.equal(calls.complete.length, 1)
    const summaryRequestText = JSON.stringify(calls.complete[0].context.messages)
    assert.match(summaryRequestText, /OLD COMPACTABLE RESULT/)
    assert.doesNotMatch(summaryRequestText, /LATEST RAW RESULT/)
    const completeNotice = calls.notifications.find((notice) =>
      /compact complete: reserve threshold/.test(notice.message),
    )
    assert.ok(completeNotice)
    assert.match(completeNotice.message, /older raw compacted: ~[1-9]\d* tok/)
    assert.match(completeNotice.message, /newest raw kept: ~[1-9]\d* tok/)
  } finally {
    ws.cleanup()
  }
})
test("preserveDialogue cancels Pi threshold without re-summarizing when the checkpoint already owns all compactable state", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const checkpointDetails = {
      cacheCompact: { mode: "preserve-dialogue-v1", version: 1 },
      checkpoint: { summary: "TOOLS ALREADY CHECKPOINTED", tokensBefore: 34_000 },
    }
    const branchEntries = [
      { type: "message", id: "u1", message: { role: "user", content: "KEEP USER", timestamp: 1 } },
      {
        type: "message",
        id: "a1",
        message: assistant([{ type: "text", text: "KEEP ANSWER" }] as any),
      },
      {
        type: "custom_message",
        id: "checkpoint-1",
        customType: "cache-compact-preserve-checkpoint",
        content: "## Tool Context Checkpoint\n\nTOOLS ALREADY CHECKPOINTED",
        display: false,
        details: checkpointDetails,
        timestamp: "2026-01-01T00:00:02.000Z",
      },
    ]
    const checkpointMessage = {
      role: "custom",
      customType: "cache-compact-preserve-checkpoint",
      content: "## Tool Context Checkpoint\n\nTOOLS ALREADY CHECKPOINTED",
      display: false,
      details: checkpointDetails,
      timestamp: 3,
    }
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      branchEntries,
      messages: [
        { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
        branchEntries[0].message,
        branchEntries[1].message,
        checkpointMessage,
      ],
      contextUsage: { tokens: 34_000, contextWindow: 50_000, percent: 68 },
      hasUI: true,
    })

    const result = await handler(
      event({ reason: "threshold", branchEntries: branchEntries as any }),
      ctx,
    )
    assert.deepEqual(result, { cancel: true })
    assert.equal(calls.complete.length, 0)
    assert.equal(calls.notifications.length, 0)
  } finally {
    ws.cleanup()
  }
})

test("preserveDialogue cancels Pi-native automatic compaction paths", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      hasUI: true,
      contextUsage: { tokens: 95_000, contextWindow: 100_000, percent: 95 },
    })
    for (const reason of ["threshold", "overflow"] as const) {
      assert.deepEqual(await handler(event({ reason }), ctx), { cancel: true })
    }
    assert.equal(calls.complete.length, 0)
    assert.equal(calls.notifications.length, 0)
  } finally {
    ws.cleanup()
  }
})

test("manual compact always runs the preserve-dialogue checkpoint path", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const toolAssistant = assistant(
      [
        { type: "text", text: "working note" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/a.ts" } },
      ] as any,
      "toolUse",
    )
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "tool evidence" }],
      isError: false,
      timestamp: 3,
    }
    const finalAnswer = assistant([{ type: "text", text: "FINAL ANSWER" }] as any)
    const branchEntries = [
      { type: "message", id: "u1", message: { role: "user", content: "inspect it", timestamp: 1 } },
      { type: "message", id: "a1", message: toolAssistant },
      { type: "message", id: "t1", message: toolResult },
      { type: "message", id: "a2", message: finalAnswer },
    ] as any
    const messages = [
      { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
      ...branchEntries.map((entry: any) => entry.message),
    ]
    const entries = [
      { sourceEntry: { id: "sys" }, messages: [messages[0]] },
      ...branchEntries.map((entry: any, index: number) => ({
        sourceEntry: { id: entry.id },
        messages: [messages[index + 1]],
      })),
    ]
    const { handler, handlers, ctx, calls } = setup({
      cwd: ws.cwd,
      hasUI: true,
      branchEntries,
      messages,
      entries,
      contextUsage: { tokens: 20_000, contextWindow: 50_000, percent: 40 },
    })

    const result = (await handler(
      event({
        reason: "manual",
        branchEntries,
        preparation: {
          firstKeptEntryId: "a2",
          tokensBefore: 20_000,
          settings: { reserveTokens: 16_384 },
          messagesToSummarize: [],
          turnPrefixMessages: [],
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        } as any,
      }),
      ctx,
    )) as any

    assert.equal(result?.cancel, undefined)
    assert.match(result.compaction.summary, /^MOCK SUMMARY/)
    assert.equal(calls.complete.length, 1)
    assert.deepEqual(result.compaction.details.checkpoint, {
    summary: result.compaction.summary,
    tokensBefore: 20_000,
    number: 1,
    coveredUserMessages: [1],
    })
    assert.match(calls.complete[0].context.messages.at(-1).content[0].text, /absolute user-message ordinal\(s\): 1/)

    await handlers.get("session_compact")!(
      {
        type: "session_compact",
        compactionEntry: {
          type: "compaction",
          id: "c1",
          parentId: "a2",
          timestamp: "2026-01-01T00:00:05.000Z",
          summary: result.compaction.summary,
          firstKeptEntryId: result.compaction.firstKeptEntryId,
          tokensBefore: result.compaction.tokensBefore,
          details: result.compaction.details,
          fromExtension: true,
        },
        fromExtension: true,
        reason: "manual",
        willRetry: false,
      } as any,
      ctx,
    )
    assert.ok(calls.notifications.some((notice) => /compact complete: manual/.test(notice.message)))
  } finally {
    ws.cleanup()
  }
})
test("preserveDialogue writes a tool-only summary and persists a restoration marker", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({ cwd: ws.cwd })
    const result = (await handler(preserveEvent(), ctx)) as any

    const askText = calls.complete[0].context.messages.at(-1).content[0].text
    assert.match(askText, /technical checkpoint ONLY from tool activity/i)
    assert.match(askText, /Do NOT summarize, paraphrase, restate, reinterpret, or quote them/)
    assert.match(askText, /thinking\/reasoning is intentionally discarded/i)
    assert.doesNotMatch(askText, /assistant reasoning\/tool-use state/i)
    assert.doesNotMatch(askText, /^## Goal$/m)
    assert.deepEqual(result.compaction.details.cacheCompact, {
      mode: "preserve-dialogue-v1",
      version: 1,
    })
  } finally {
    ws.cleanup()
  }
})

test("context hook restores old dialogue verbatim and keeps the technical summary once", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const branchEntries = [
      {
        type: "message",
        id: "u-old",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "EXACT OLD PROMPT", timestamp: 1 },
      },
      {
        type: "message",
        id: "a-old",
        parentId: "u-old",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          ...assistant([
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "EXACT OLD RESPONSE" },
          ] as any),
        },
      },
      {
        type: "message",
        id: "keep-1",
        parentId: "a-old",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: "RECENT PROMPT", timestamp: 3 },
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "keep-1",
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: "## Tool Context\n- inspected x",
        firstKeptEntryId: "keep-1",
        tokensBefore: 1000,
        details: { cacheCompact: { mode: "preserve-dialogue-v1", version: 1 } },
      },
    ]
    const { ctx, handlers } = setup({ cwd: ws.cwd, branchEntries })
    const contextHandler = handlers.get("context")!
    const restored = await contextHandler(
      {
        type: "context",
        messages: [
          {
            role: "compactionSummary",
            summary: "## Tool Context\n- inspected x",
            tokensBefore: 1000,
            timestamp: 4,
          },
          { role: "user", content: "RECENT PROMPT", timestamp: 3 },
        ],
      },
      ctx,
    )

    assert.deepEqual(
      restored.messages.map((message: any) => message.role),
      ["user", "assistant", "user", "compactionSummary"],
    )
    assert.equal(restored.messages[0].content, "EXACT OLD PROMPT")
    assert.deepEqual(restored.messages[1].content, [{ type: "text", text: "EXACT OLD RESPONSE" }])
    assert.equal(restored.messages[2].content, "RECENT PROMPT")
    assert.equal(
      restored.messages.filter((message: any) => message.role === "compactionSummary").length,
      1,
    )
    assert.ok(!JSON.stringify(restored.messages).includes("hidden"))
    assert.ok(!JSON.stringify(restored.messages).includes("tool-1"))
  } finally {
    ws.cleanup()
  }
})

test("a later preserveDialogue compaction summarizes the same restored dialogue view sent live", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const oldSummary = {
      role: "compactionSummary",
      summary: "## Tool Context\nold tool state",
      tokensBefore: 900,
      timestamp: 3,
    }
    const keptOne = { role: "user", content: "KEPT ONE", timestamp: 4 }
    const afterOne = assistant(
    [
    { type: "text", text: "AFTER ONE" },
    { type: "toolCall", id: "new-tool", name: "read", arguments: { path: "new.ts" } },
    ] as any,
    "toolUse",
    )
    const keepTwo = { role: "user", content: "KEEP TWO", timestamp: 6 }
    const branchEntries = [
      {
        type: "message",
        id: "u-old",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "EXACT OLD PROMPT", timestamp: 1 },
      },
      {
        type: "message",
        id: "a-old",
        parentId: "u-old",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          ...assistant([{ type: "text", text: "EXACT OLD RESPONSE" }] as any),
        },
      },
      {
        type: "message",
        id: "keep-1",
        parentId: "a-old",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: keptOne,
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "keep-1",
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: oldSummary.summary,
        firstKeptEntryId: "keep-1",
        tokensBefore: 900,
        details: { cacheCompact: { mode: "preserve-dialogue-v1", version: 1 } },
      },
      {
        type: "message",
        id: "after-1",
        parentId: "compact-1",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: afterOne,
      },
      {
        type: "message",
        id: "keep-2",
        parentId: "after-1",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: keepTwo,
      },
    ]
    const entries = [
      { sourceEntry: { id: "compact-1" }, messages: [oldSummary] },
      { sourceEntry: { id: "keep-1" }, messages: [keptOne] },
      { sourceEntry: { id: "after-1" }, messages: [afterOne] },
      { sourceEntry: { id: "keep-2" }, messages: [keepTwo] },
    ]
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      messages: [
        { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
        oldSummary,
        keptOne,
        afterOne,
        keepTwo,
      ],
      entries,
    })

    await handler(
      preserveEvent({
        preserveTailStartEntryId: "keep-2",
        preserveTailMessageCount: 1,
        preservePrefixTokens: 1_800,
        preparation: {
          firstKeptEntryId: "keep-2",
          tokensBefore: 1800,
          previousSummary: oldSummary.summary,
          turnPrefixMessages: [],
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        } as any,
        branchEntries: branchEntries as any,
      }),
      ctx,
    )

    const summaryContext = calls.complete[0].context.messages
    const serialized = JSON.stringify(summaryContext)
    assert.ok(serialized.includes("EXACT OLD PROMPT"))
    assert.ok(serialized.includes("EXACT OLD RESPONSE"))
    assert.ok(serialized.includes("old tool state"))
    assert.ok(!serialized.includes("old-tool"))
    assert.match(
      summaryContext.at(-1).content[0].text,
      /NEW compact incremental technical checkpoint/,
    )
  } finally {
    ws.cleanup()
  }
})

test("continuation: false sends the dropped span only", async () => {
  const ws = tempWorkspace({ continuation: false })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({ cwd: ws.cwd })
    await handler(event(), ctx)

    const { context } = calls.complete[0]
    // The old shape: dropped span (system, user, assistant) + ask, so the kept
    // tail is not resent. Correct summaries, but a cache rewind on an
    // append-only server.
    assert.equal(context.messages.length, 4)
    assert.ok(
      !context.messages.some((message: any) => message.content === "recent kept message"),
      "the kept tail must not be resent with continuation: false",
    )
    const askText = context.messages.at(-1).content[0].text
    // Nothing in the request is outside the summary's scope, so no boundary note.
    assert.doesNotMatch(askText, /stay in the context verbatim/)
  } finally {
    ws.cleanup()
  }
})

test("a continuation that would not fit defers to Pi instead of rewinding", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-rewind-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    // Small dropped span, huge kept tail: no continuation fits. The rewind is
    // the only option left and has never reused a cache, so Pi's small summary
    // is the cheaper choice.
    const huge = "x".repeat(200_000)
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      model: { provider: "mock", id: "test-model", contextWindow: 32_000 },
      messages: [
        { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
        { role: "user", content: "hello from the session", timestamp: 1 },
        { role: "user", content: huge, timestamp: 3 },
      ],
      entries: [
        {
          sourceEntry: { id: "sys" },
          messages: [{ role: "system", content: "SYSTEM PROMPT", timestamp: 0 }],
        },
        {
          sourceEntry: { id: "u1" },
          messages: [{ role: "user", content: "hello from the session", timestamp: 1 }],
        },
        {
          sourceEntry: { id: "keep-1" },
          messages: [{ role: "user", content: huge, timestamp: 3 }],
        },
      ],
    })
    assert.equal(await handler(event(), ctx), undefined)
    assert.equal(calls.complete.length, 0, "sent the rewinding shape instead of deferring")
    assert.ok(
      readRecords(debugFile).some((r) => /only the rewinding shape fits/.test(r.kind)),
      "no deferral record",
    )
  } finally {
    ws.cleanup()
  }
})

test("preserveDialogue synthetic checkpoint uses the fitted reserve and actual request fit", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const finalAssistant = {
      ...assistant([{ type: "text", text: "KEEP FINAL ANSWER" }] as any),
      usage: {
        input: 36_954,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 36_955,
        cost: {},
      },
    }
    const branchEntries = [
      { type: "message", id: "u1", message: { role: "user", content: "KEEP USER", timestamp: 1 } },
      {
        type: "message",
        id: "a1",
        message: assistant([
          { type: "text", text: "KEEP FIRST ANSWER" },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        ] as any),
      },
      {
        type: "message",
        id: "t1",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(90_000) }],
          isError: false,
          timestamp: 3,
        },
      },
      { type: "message", id: "a2", message: finalAssistant },
    ]
    const messages = [
      { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
      ...branchEntries.map((entry: any) => entry.message),
    ]
    const entries = [
      { sourceEntry: { id: "sys" }, messages: [messages[0]] },
      ...branchEntries.map((entry: any, index: number) => ({
        sourceEntry: { id: entry.id },
        messages: [messages[index + 1]],
      })),
    ]
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      model: { provider: "mock", id: "test-model", contextWindow: 50_000 },
      branchEntries,
      messages,
      entries,
    })

    const result = (await handler(
      preserveEvent({
        preserveTailStartEntryId: "a2",
        preserveTailMessageCount: 1,
        preservePrefixTokens: 36_954,
        reason: "manual",
        preparation: {
          firstKeptEntryId: "a2",
          tokensBefore: 36_954,
          settings: { reserveTokens: 16_384 },
          turnPrefixMessages: [],
          fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        } as any,
        branchEntries: branchEntries as any,
      }),
      ctx,
    )) as any

    assert.equal(result?.cancel, undefined)
    assert.equal(result.compaction.summary, "MOCK SUMMARY")
    assert.equal(calls.complete.length, 1)
    assert.ok(calls.complete[0].options.maxTokens > 0)
    assert.ok(calls.complete[0].options.maxTokens <= 8_886)
  } finally {
    ws.cleanup()
  }
})

test("preserveDialogue native threshold cancellation never invokes a fallback summary", async () => {
  const ws = tempWorkspace({ preserveDialogue: true, debug: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const huge = "x".repeat(200_000)
    const { handler, handlers, ctx, calls } = setup({
      cwd: ws.cwd,
      hasUI: true,
      model: { provider: "mock", id: "test-model", contextWindow: 32_000 },
      messages: [
        { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
        { role: "user", content: "hello from the session", timestamp: 1 },
        { role: "user", content: huge, timestamp: 3 },
      ],
      entries: [
        {
          sourceEntry: { id: "sys" },
          messages: [{ role: "system", content: "SYSTEM PROMPT", timestamp: 0 }],
        },
        {
          sourceEntry: { id: "u1" },
          messages: [{ role: "user", content: "hello from the session", timestamp: 1 }],
        },
        {
          sourceEntry: { id: "keep-1" },
          messages: [{ role: "user", content: huge, timestamp: 3 }],
        },
      ],
    })
    assert.deepEqual(await handler(event({ reason: "threshold" }), ctx), { cancel: true })
    assert.equal(calls.complete.length, 0)
    assert.equal(calls.notifications.length, 0)
  } finally {
    ws.cleanup()
  }
})

test("rewindWhenNeeded: true sends the dropped span when nothing else fits", async () => {
  const ws = tempWorkspace({ rewindWhenNeeded: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const huge = "x".repeat(200_000)
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      model: { provider: "mock", id: "test-model", contextWindow: 32_000 },
      messages: [
        { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
        { role: "user", content: "hello from the session", timestamp: 1 },
        { role: "user", content: huge, timestamp: 3 },
      ],
      entries: [
        {
          sourceEntry: { id: "sys" },
          messages: [{ role: "system", content: "SYSTEM PROMPT", timestamp: 0 }],
        },
        {
          sourceEntry: { id: "u1" },
          messages: [{ role: "user", content: "hello from the session", timestamp: 1 }],
        },
        {
          sourceEntry: { id: "keep-1" },
          messages: [{ role: "user", content: huge, timestamp: 3 }],
        },
      ],
    })
    await handler(event(), ctx)
    // Dropped span (system, user) + ask, with the oversized tail left out.
    assert.equal(calls.complete.length, 1)
    assert.equal(calls.complete[0].context.messages.length, 3)
    assert.ok(!calls.complete[0].context.messages.some((m: any) => m.content === huge))
  } finally {
    ws.cleanup()
  }
})

test("rejects unusable summaries and leaves compaction to Pi", async () => {
  const cases: Array<[AssistantMessage, RegExp]> = [
    [assistant([{ type: "text", text: "  " }]), /no summary text/],
    [assistant([{ type: "text", text: "partial" }], "length"), /token cap/],
    [
      assistant([{ type: "toolCall", id: "1", name: "read", arguments: {} }] as any, "toolUse"),
      /call a tool/,
    ],
  ]
  for (const [response] of cases) {
    const ws = tempWorkspace()
    process.env.PI_CODING_AGENT_DIR = ws.agentDir
    try {
      const { handler, ctx } = setup({ cwd: ws.cwd, response })
      assert.equal(await handler(event(), ctx), undefined)
    } finally {
      ws.cleanup()
    }
  }
})

test("preserveDialogue cancels when an unusable summary would otherwise fall back to Pi", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx } = setup({
      cwd: ws.cwd,
      response: assistant([{ type: "text", text: "partial" }], "length"),
    })
    assert.deepEqual(await handler(preserveEvent(), ctx), { cancel: true })
  } finally {
    ws.cleanup()
  }
})

test("preserveDialogue rejects user-message headings invented from the synthetic checkpoint ask", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: assistant([
        {
          type: "text",
          text: "## Tool Context\n\n### User message 3\n#### Findings\n- synthetic control text",
        },
      ]),
    })
    assert.deepEqual(await handler(preserveEvent(), ctx), { cancel: true })
    assert.equal(calls.compact.length, 0)
  } finally {
    ws.cleanup()
  }
})

test("preserveDialogue cancels when the summary request throws", async () => {
  const ws = tempWorkspace({ preserveDialogue: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx } = setup({
      cwd: ws.cwd,
      response: async () => {
        throw new Error("connection refused")
      },
    })
    assert.deepEqual(await handler(preserveEvent(), ctx), { cancel: true })
  } finally {
    ws.cleanup()
  }
})

test("falls back to Pi's default when the summary request throws", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx } = setup({
      cwd: ws.cwd,
      response: async () => {
        throw new Error("connection refused")
      },
    })
    assert.equal(await handler(event(), ctx), undefined)
  } finally {
    ws.cleanup()
  }
})

test("ignores sessions whose model is not listed, including preserve restoration and UI", async () => {
  const ws = tempWorkspace({ preserveDialogue: true, models: ["other/model"] })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const branchEntries = [
      {
        type: "message",
        id: "u-old",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "OLD", timestamp: 1 },
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "u-old",
        timestamp: "2026-01-01T00:00:01.000Z",
        summary: "TOOLS",
        firstKeptEntryId: null,
        tokensBefore: 1000,
        details: { cacheCompact: { mode: "preserve-dialogue-v1", version: 1 } },
      },
    ]
    const { handler, handlers, ctx, calls } = setup({ cwd: ws.cwd, branchEntries, hasUI: true })
    assert.equal(await handler(event({ branchEntries: branchEntries as any }), ctx), undefined)
    assert.equal(calls.complete.length, 0)
    assert.equal(await handlers.get("context")!({ type: "context", messages: [] }, ctx), undefined)
    assert.equal(typeof handlers.get("session_compact"), "function")
    assert.equal(calls.notifications.length, 0)
  } finally {
    ws.cleanup()
  }
})

test("honours a custom prompt, a summarizer model, and custom instructions", async () => {
  const ws = tempWorkspace({
    summaryModel: { provider: "mock", id: "small" },
    summaryPrompt: "CUSTOM HANDOFF",
    obsoleteSummaryMaxTokens: 321,
  })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const small = { provider: "mock", id: "small" }
    const { handler, ctx, calls } = setup({ cwd: ws.cwd, foundModel: small })
    await handler(event({ customInstructions: "focus on the tests" }), ctx)

    assert.equal(calls.complete[0].model, small)
    assert.equal(calls.complete[0].options.maxTokens, 13_107)
    // Unset summaryReasoningEffort must leave the server's default effort
    // untouched — sending null/undefined explicitly would change the request.
    assert.equal("reasoningEffort" in calls.complete[0].options, false)
    const askText = calls.complete[0].context.messages.at(-1).content[0].text
    assert.ok(askText.startsWith("CUSTOM HANDOFF\n\nDo not call any tools."))
    assert.match(askText, /Additional focus: focus on the tests/)
    // The boundary note is appended after the custom text, not instead of it.
    assert.match(askText, /stay in the context verbatim/)
  } finally {
    ws.cleanup()
  }
})

test("forwards summaryReasoningEffort and derives the summary ceiling", async () => {
  const ws = tempWorkspace({ summaryReasoningEffort: "minimal" })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({ cwd: ws.cwd })
    await handler(event(), ctx)

    assert.equal(calls.complete.length, 1)
    assert.equal(calls.complete[0].options.reasoningEffort, "minimal")
    // Non-preserve mode keeps Pi's 0.8 x reserveTokens output ceiling.
    assert.equal(calls.complete[0].options.maxTokens, 13_107)
  } finally {
    ws.cleanup()
  }
})

test("summary ask mirrors the last live reasoning effort, following mid-session changes", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, providerHandler, ctx, calls } = setup({ cwd: ws.cwd })

    providerHandler(
      { type: "before_provider_request", payload: { model: "m", reasoning_effort: "high" } },
      ctx,
    )
    await handler(event(), ctx)
    assert.equal(calls.complete[0].options.reasoningEffort, "high")

    // /thinking changed after the last observed live request: the cached
    // prefix is keyed by the newest live payload, so the next ask follows it.
    providerHandler(
      { type: "before_provider_request", payload: { model: "m", reasoning_effort: "minimal" } },
      ctx,
    )
    await handler(event(), ctx)
    assert.equal(calls.complete[1].options.reasoningEffort, "minimal")
  } finally {
    ws.cleanup()
  }
})

test("omits effort when live requests omit it; config overrides observation", async () => {
  const withOverride = tempWorkspace({ summaryReasoningEffort: "low" })
  const plain = tempWorkspace()
  try {
    // Live omits the effort -> the ask must omit it too (third cache variant).
    process.env.PI_CODING_AGENT_DIR = plain.agentDir
    {
      const { handler, providerHandler, ctx, calls } = setup({ cwd: plain.cwd })
      providerHandler({ type: "before_provider_request", payload: { model: "m" } }, ctx)
      await handler(event(), ctx)
      assert.equal("reasoningEffort" in calls.complete[0].options, false)
    }
    // Explicit config wins over whatever is on the wire.
    process.env.PI_CODING_AGENT_DIR = withOverride.agentDir
    {
      const { handler, providerHandler, ctx, calls } = setup({ cwd: withOverride.cwd })
      providerHandler(
        { type: "before_provider_request", payload: { model: "m", reasoning_effort: "high" } },
        ctx,
      )
      await handler(event(), ctx)
      assert.equal(calls.complete[0].options.reasoningEffort, "low")
    }
  } finally {
    withOverride.cleanup()
    plain.cleanup()
  }
})

test("malformed config falls back to the documented preserveDialogue default", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    fs.writeFileSync(path.join(ws.cwd, ".pi", "cache-compact.json"), "{")
    const { handler, ctx } = setup({ cwd: ws.cwd })
    const result = (await handler(preserveEvent(), ctx)) as any
    assert.deepEqual(result.compaction.details.cacheCompact, {
      mode: "preserve-dialogue-v1",
      version: 1,
    })
  } finally {
    ws.cleanup()
  }
})

test("disabled mode leaves Pi compaction, context, and UI untouched", async () => {
  const ws = tempWorkspace({ enabled: false })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const branchEntries = [
      {
        type: "message",
        id: "u-old",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "OLD", timestamp: 1 },
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "u-old",
        timestamp: "2026-01-01T00:00:01.000Z",
        summary: "TOOLS",
        firstKeptEntryId: null,
        tokensBefore: 1000,
        details: { cacheCompact: { mode: "preserve-dialogue-v1", version: 1 } },
      },
    ]
    const { handler, handlers, ctx, calls } = setup({ cwd: ws.cwd, branchEntries, hasUI: true })
    assert.equal(await handler(event({ branchEntries: branchEntries as any }), ctx), undefined)
    assert.equal(calls.complete.length, 0)
    const restored = await handlers.get("context")!(
      {
        type: "context",
        messages: [
          { role: "compactionSummary", summary: "TOOLS", tokensBefore: 1000, timestamp: 2 },
        ],
      },
      ctx,
    )
    assert.equal(restored, undefined)
    assert.equal(typeof handlers.get("session_compact"), "function")
    assert.equal(calls.notifications.length, 0)
  } finally {
    ws.cleanup()
  }
})

function readRecords(file: string): any[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test("debug records the compaction lifecycle to debugFile", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-dbg-")), "debug.jsonl")
  const ws = tempWorkspace({ preserveDialogue: true, debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, providerHandler, ctx } = setup({ cwd: ws.cwd })
    providerHandler(
      {
        type: "before_provider_request",
        payload: {
          model: "m",
          messages: [
            { role: "system", content: "SYSTEM PROMPT" },
            { role: "user", content: "hello from the session" },
          ],
        },
      },
      ctx,
    )
    await handler(preserveEvent(), ctx)
    providerHandler(
      {
        type: "before_provider_request",
        payload: {
          model: "m",
          messages: [
            { role: "system", content: "SYSTEM PROMPT" },
            { role: "user", content: "hello from the session" },
            { role: "user", content: "after checkpoint" },
          ],
        },
      },
      ctx,
    )

    const records = readRecords(debugFile)
    const start = records.find((r) => r.kind === "summary_start")
    const result = records.find((r) => r.kind === "summary_result")
    const audit = records.find((r) => r.kind === "preserve_compaction")
    const post = records.find((r) => r.kind === "post_compaction_context")
    assert.ok(start, "no summary_start record")
    assert.equal(start.sessionId, "sess-1")
    assert.equal(start.askHash.length, 12)
    assert.equal(start.tokensBefore, 1234)
    assert.ok(result, "no summary_result record")
    assert.equal(result.chars, "MOCK SUMMARY".length)
    assert.equal(result.cacheRead, 5)
    assert.equal(typeof result.durationMs, "number")
    assert.ok(audit, "no canonical preserve_compaction audit record")
    assert.equal(audit.checkpoint.number, 1)
    assert.ok(Array.isArray(audit.contextBefore))
    assert.ok(Array.isArray(audit.contextAfter))
    assert.ok(Array.isArray(audit.contextIndex.before))
    assert.ok(Array.isArray(audit.contextIndex.after))
    assert.equal(typeof audit.contextIndex.before[0]?.estimatedTokens, "number")
    assert.ok(Array.isArray(audit.toolDeclarations))
    assert.equal(typeof audit.tokens.providerContextBefore, "number")
    assert.equal(typeof audit.tokens.providerPromptOverhead, "number")
    assert.equal(typeof audit.tokens.estimatedSystemPrompt, "number")
    assert.equal(typeof audit.tokens.estimatedToolDeclarations, "number")
    assert.equal(typeof audit.tokens.estimatedOtherProviderOverhead, "number")
    assert.equal(typeof audit.tokens.estimatedContextAfter, "number")
    assert.equal(typeof audit.tokens.preservedUserMessages, "number")
    assert.equal(typeof audit.tokens.preservedAssistantText, "number")
    assert.equal(typeof audit.tokens.newRawCompactable, "number")
    assert.equal(audit.tokens.remainingRawCompactable, 0)
    assert.ok(Array.isArray(audit.scope.rawEntryIds))
    assert.ok(post, "no actual post_compaction_context record")
    assert.ok(Array.isArray(post.context.messages))
    assert.equal(typeof post.cachePrefix.stableMessages, "number")
  } finally {
    ws.cleanup()
  }
})

test("provider requests are fingerprinted and the in-flight summary is tagged", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-dbg-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    // While the summarization request is in flight, replay a provider hook
    // with a payload whose last message is the ask — it must be tagged.
    const { handler, providerHandler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () => {
        const askText = calls.complete[0].context.messages.at(-1).content[0].text
        // A live-looking request: must not be tagged.
        providerHandler(
          {
            type: "before_provider_request",
            payload: { model: "m", messages: [{ role: "user", content: "hi" }] },
          },
          ctx,
        )
        // Our summarization request: last user message is the ask.
        providerHandler(
          {
            type: "before_provider_request",
            payload: {
              model: "m",
              tools: [{ type: "function", function: { name: "read" } }],
              messages: [
                { role: "system", content: "SYSTEM PROMPT" },
                { role: "user", content: [{ type: "text", text: askText }] },
              ],
            },
          },
          ctx,
        )
        return {
          role: "assistant",
          content: [{ type: "text", text: "MOCK SUMMARY" }],
          api: "openai-completions",
          provider: "mock",
          model: "test-model",
          usage: { input: 1, output: 1, cacheRead: 5, cacheWrite: 0, totalTokens: 2, cost: {} },
          stopReason: "stop",
          timestamp: Date.now(),
        } as any
      },
    })
    await handler(event(), ctx)

    const providerRecords = readRecords(debugFile).filter((r) => r.kind === "provider_request")
    // Three: the extension's own summary record (written via the mock's
    // onPayload callback), plus the two payloads replayed through the hook
    // from the response callback: a live-looking one and the ask-bearing one.
    assert.equal(providerRecords.length, 3)
    const live = providerRecords.find((r) => r.summary === undefined)
    const own = providerRecords.find((r) => r.summary === true && r.systemSource !== undefined)
    const tagged = providerRecords.find((r) => r.summary === true && r.systemSource === undefined)
    assert.ok(
      live && own && tagged,
      `expected one live, one own, one tagged record:\n${JSON.stringify(providerRecords, null, 1)}`,
    )
    assert.equal(live.pendingSummary, true)
    assert.equal(live.messageCount, 1)
    assert.equal(tagged.toolsCount, 1)
    assert.equal(
      tagged.rolling.length,
      2,
      "the two-message ask payload must be tagged summary=true",
    )
    assert.ok(own.rolling.length > 2, "the extension's own request comes from onPayload")
  } finally {
    ws.cleanup()
  }
})

test("debug: false never creates the configured log file", () => {
  const debugDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-debug-off-"))
  const debugFile = path.join(debugDir, "debug.jsonl")
  const ws = tempWorkspace({ debug: false, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { providerHandler, ctx } = setup({ cwd: ws.cwd })
    assert.doesNotThrow(() =>
      providerHandler({ type: "before_provider_request", payload: undefined }, ctx),
    )
    assert.doesNotThrow(() =>
      providerHandler({ type: "before_provider_request", payload: { messages: [{}] } }, ctx),
    )
    assert.equal(fs.existsSync(debugFile), false)
  } finally {
    ws.cleanup()
    fs.rmSync(debugDir, { recursive: true, force: true })
  }
})

test("debugPayloads dumps live_before, summarization, and live_after", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-dump-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile, debugPayloads: true })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, providerHandler, ctx } = setup({ cwd: ws.cwd })

    // A live request before compaction.
    providerHandler(
      {
        type: "before_provider_request",
        payload: {
          model: "m",
          tools: [
            {
              type: "function",
              function: {
                name: "read",
                description: "TOOL_SCHEMA_SENTINEL",
                parameters: { type: "object" },
              },
            },
          ],
          messages: [
            { role: "system", content: "SYSTEM PROMPT" },
            { role: "user", content: "hello from the session" },
          ],
        },
      },
      ctx,
    )
    await handler(event(), ctx)
    // First live request after compaction.
    providerHandler(
      {
        type: "before_provider_request",
        payload: {
          model: "m",
          tools: [
            {
              type: "function",
              function: {
                name: "read",
                description: "TOOL_SCHEMA_SENTINEL",
                parameters: { type: "object" },
              },
            },
          ],
          messages: [{ role: "system", content: "SYSTEM PROMPT" }],
        },
      },
      ctx,
    )

    const dumps = readRecords(debugFile).filter((r) => r.kind === "payload_dump")
    const byVariant = Object.fromEntries(dumps.map((r) => [r.variant, r]))
    assert.deepEqual(Object.keys(byVariant).sort(), ["live_after", "live_before", "summarization"])
    assert.equal(byVariant.live_before.payload.messages.length, 2)
    assert.equal(byVariant.live_after.payload.messages.length, 1)
    assert.deepEqual(byVariant.live_before.payload.tools, ["read"])
    assert.deepEqual(byVariant.live_after.payload.tools, ["read"])
    assert.deepEqual(byVariant.summarization.payload.tools, ["read"])
    assert.doesNotMatch(fs.readFileSync(debugFile, "utf8"), /TOOL_SCHEMA_SENTINEL/)
    // The mock projection starts with a recorded system message.
    assert.equal(byVariant.summarization.systemSource, "recorded")
    const summaryMessages = byVariant.summarization.payload.messages
    assert.match(summaryMessages.at(-1).content[0].text, /summary/i)

    // The compare script runs against the dump and finds a shared prefix.
    const { execFileSync } = await import("node:child_process")
    const script = fileURLToPath(new URL("../scripts/compare-dumps.mjs", import.meta.url))
    let out = ""
    try {
      out = execFileSync("node", [script, debugFile], { encoding: "utf8" })
    } catch (error: any) {
      out = String(error.stdout ?? "") // exit 1 = divergence found, still prints
    }
    assert.match(out, /shared prefix=\d+/)
    assert.match(out, /byte-identical prefix|diverge/)
  } finally {
    ws.cleanup()
  }
})

test("no payload dumps without debugPayloads", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-dump-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, providerHandler, ctx } = setup({ cwd: ws.cwd })
    providerHandler(
      { type: "before_provider_request", payload: { messages: [{ role: "user", content: "x" }] } },
      ctx,
    )
    await handler(event(), ctx)
    const kinds = readRecords(debugFile).map((r) => r.kind)
    assert.ok(!kinds.includes("payload_dump"))
    assert.ok(kinds.includes("summary_result"))
  } finally {
    ws.cleanup()
  }
})

test("summary ask replays captured live request headers", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, handlers, ctx, calls } = setup({ cwd: ws.cwd })
    handlers.get("before_provider_headers")!(
      {
        type: "before_provider_headers",
        headers: {
          "x-session-affinity": "aff-123",
          "user-agent": "pi/1.2.3",
          "content-length": "99999",
          connection: "keep-alive",
          "x-deleted": null,
        },
      },
      ctx,
    )
    await handler(event(), ctx)

    assert.equal(calls.complete.length, 1)
    assert.deepEqual(calls.complete[0].options.headers, {
      "x-session-affinity": "aff-123",
      "user-agent": "pi/1.2.3",
    })
  } finally {
    ws.cleanup()
  }
})

test("no headers option when no live request was observed", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({ cwd: ws.cwd })
    await handler(event(), ctx)
    assert.equal("headers" in calls.complete[0].options, false)
  } finally {
    ws.cleanup()
  }
})

test("debug logs live and summary headers and response headers, redacted", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-hdr-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, handlers, ctx, calls } = setup({ cwd: ws.cwd })
    handlers.get("before_provider_headers")!(
      {
        type: "before_provider_headers",
        headers: { authorization: "Bearer supersecret", "x-replica-pin": "r7" },
      },
      ctx,
    )
    handlers.get("after_provider_response")!(
      {
        type: "after_provider_response",
        status: 200,
        headers: { "x-replica": "r7", "set-cookie": "s=1" },
      },
      ctx,
    )
    await handler(event(), ctx)

    const records = readRecords(debugFile)
    const headerRecords = records.filter((r) => r.kind === "provider_headers")
    const responseRecords = records.filter((r) => r.kind === "provider_response")

    const liveHeaders = headerRecords.find((r) => r.summary === false)
    assert.equal(liveHeaders.headers["x-replica-pin"], "r7")
    assert.equal(liveHeaders.headers.authorization, "[redacted]")

    const liveResponse = responseRecords.find((r) => r.summary === false)
    assert.equal(liveResponse.status, 200)
    assert.equal(liveResponse.headers["x-replica"], "r7")
    assert.equal(liveResponse.headers["set-cookie"], "[redacted]")

    const summaryHeaders = headerRecords.find((r) => r.summary === true)
    assert.equal(summaryHeaders.liveCaptured, true)
    // authorization is replayed but logged redacted.
    assert.equal(summaryHeaders.headers.authorization, "[redacted]")
    assert.equal(summaryHeaders.headers["x-replica-pin"], "r7")

    // The mock complete() answers via onResponse; that must land as a record.
    const summaryResponse = responseRecords.find((r) => r.summary === true)
    assert.equal(summaryResponse.status, 200)
    assert.equal(summaryResponse.headers["x-replica"], "mock-1")
    assert.equal(summaryResponse.headers["set-cookie"], "[redacted]")
  } finally {
    ws.cleanup()
  }
})

test("header handlers never throw on junk", () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handlers, ctx } = setup({ cwd: ws.cwd })
    assert.doesNotThrow(() =>
      handlers.get("before_provider_headers")!(
        { type: "before_provider_headers", headers: undefined },
        ctx,
      ),
    )
    assert.doesNotThrow(() =>
      handlers.get("after_provider_response")!(
        { type: "after_provider_response", status: 500, headers: undefined },
        ctx,
      ),
    )
  } finally {
    ws.cleanup()
  }
})

test("continues the last live request when a trailing tool result is huge", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    // Production shape: Pi compacts *because* a big tool result arrived, so the
    // projection no longer fits — but the request the server has cached still
    // does, and appending the ask to it stays a forward continuation.
    const huge = "x".repeat(200_000)
    const { handler, providerHandler, ctx, calls } = setup({
      cwd: ws.cwd,
      model: { provider: "mock", id: "test-model", contextWindow: 32_000 },
      messages: [
        { role: "system", content: "SYSTEM PROMPT", timestamp: 0 },
        { role: "user", content: "hello from the session", timestamp: 1 },
        { role: "user", content: "recent kept message", timestamp: 3 },
        { role: "toolResult", content: huge, timestamp: 4 },
      ],
      entries: [
        {
          sourceEntry: { id: "sys" },
          messages: [{ role: "system", content: "SYSTEM PROMPT", timestamp: 0 }],
        },
        {
          sourceEntry: { id: "u1" },
          messages: [{ role: "user", content: "hello from the session", timestamp: 1 }],
        },
        {
          sourceEntry: { id: "keep-1" },
          messages: [{ role: "user", content: "recent kept message", timestamp: 3 }],
        },
        {
          sourceEntry: { id: "tr1" },
          messages: [{ role: "toolResult", content: huge, timestamp: 4 }],
        },
      ],
    })
    // The last live request carried the first three messages.
    providerHandler(
      {
        type: "before_provider_request",
        payload: {
          model: "m",
          messages: [
            { role: "system", content: "SYSTEM PROMPT" },
            { role: "user", content: "hello from the session" },
            { role: "user", content: "recent kept message" },
          ],
        },
      },
      ctx,
    )
    await handler(event(), ctx)

    const { context } = calls.complete[0]
    // system + user + kept message + ask: exactly the cached request plus the ask.
    assert.equal(context.messages.length, 4)
    assert.equal(context.messages.at(-2).content, "recent kept message")
    assert.ok(
      !context.messages.some((message: any) => message.content === huge),
      "the oversized tool result must be left out of the request",
    )
  } finally {
    ws.cleanup()
  }
})

test("summary provider errors use Pi settings.retry before preserve compaction fails", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-provider-retry-")), "debug.jsonl")
  const ws = tempWorkspace({ preserveDialogue: true, debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  fs.writeFileSync(
    path.join(ws.agentDir, "settings.json"),
    JSON.stringify({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 1 },
    }),
  )
  try {
    let attempt = 0
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () => {
        attempt += 1
        if (attempt < 3) {
          return {
            ...assistant([], "error"),
            errorMessage: '429: {"message":"Provider returned error","code":429,"metadata":{"raw":"rate limit exceeded"}}',
          }
        }
        return assistant([{ type: "text", text: "RETRY RECOVERED SUMMARY" }])
      },
    })

    const result = (await handler(preserveEvent(), ctx)) as any
    assert.equal(calls.complete.length, 3)
    assert.equal(result.compaction.summary, "RETRY RECOVERED SUMMARY")

    const records = readRecords(debugFile)
    const scheduled = records.filter((record) => record.kind === "summary_provider_retry_scheduled")
    assert.deepEqual(
      scheduled.map((record) => [record.attempt, record.maxAttempts, record.delayMs]),
      [
        [1, 2, 1],
        [2, 2, 1],
      ],
    )
    const finished = records.find((record) => record.kind === "summary_provider_retry_finished")
    assert.equal(finished?.success, true)
    assert.equal(finished?.attempt, 2)
  } finally {
    ws.cleanup()
  }
})

test("retries once when the reply stopped with no text, then gives up", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-retry-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    // First attempt: thinking only, no text (the production failure). Second:
    // a proper summary, so the retry is what saves the compaction.
    let attempt = 0
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () => {
        attempt++
        return attempt === 1
          ? assistant([{ type: "thinking", thinking: "let me plan the summary" }] as any)
          : assistant([{ type: "text", text: "RETRIED SUMMARY" }])
      },
    })
    const result = (await handler(preserveEvent(), ctx)) as any
    assert.equal(calls.complete.length, 2)
    assert.equal(result.compaction.summary, "RETRIED SUMMARY")

    // The retry keeps the same prefix and only nudges the end of the ask, so the
    // cache still covers everything before the ask.
    const first = calls.complete[0].context.messages
    const second = calls.complete[1].context.messages
    assert.deepEqual(second.slice(0, -1), first.slice(0, -1))
    assert.ok(second.at(-1).content[0].text.startsWith(first.at(-1).content[0].text))
    assert.match(second.at(-1).content[0].text, /Reminder: reply with the summary text itself/)

    // The retry is recorded, with the reason it was attempted (the first reply's
    // shape) and its own outcome.
    const retry = readRecords(debugFile).find((r) => r.kind === "summary_retry")
    assert.ok(retry, `no summary_retry record`)
    assert.equal(retry.reason, undefined, `retry did not succeed`)
    assert.equal(retry.stopReason, "stop")
  } finally {
    ws.cleanup()
  }
})

test("does not retry failures that would repeat (token cap, tool call, abort)", async () => {
  for (const [response, pattern] of [
    [assistant([{ type: "text", text: "partial" }], "length"), /token cap/],
    [
      assistant([{ type: "toolCall", id: "1", name: "read", arguments: {} }] as any, "toolUse"),
      /call a tool/,
    ],
    [assistant([{ type: "text", text: "x" }], "aborted"), /aborted/],
  ] as const) {
    const ws = tempWorkspace()
    process.env.PI_CODING_AGENT_DIR = ws.agentDir
    try {
      const { handler, ctx, calls } = setup({ cwd: ws.cwd, response })
      assert.equal(await handler(event(), ctx), undefined)
      assert.equal(calls.complete.length, 1, `retried a ${pattern} failure`)
    } finally {
      ws.cleanup()
    }
  }
})

test("an empty reply retried into another empty reply falls back to Pi", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () =>
        assistant([{ type: "thinking", thinking: "still deliberating" }] as any),
    })
    assert.equal(await handler(event(), ctx), undefined)
    assert.equal(calls.complete.length, 2)
  } finally {
    ws.cleanup()
  }
})

function withUsage(usage: Record<string, number> & { content?: any[] }): any {
  const { content, ...rest } = usage
  return {
    role: "assistant",
    content: content ?? [{ type: "text", text: "MOCK SUMMARY" }],
    api: "openai-completions",
    provider: "mock",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {}, ...rest },
    stopReason: "stop",
    timestamp: Date.now(),
  }
}

test("a cold continuation miss does not disable the next compaction", async () => {
  const debugFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cc-defer-")), "debug.jsonl")
  const ws = tempWorkspace({ debug: true, debugFile })
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    // A cold read of a large prompt: the server no longer holds the conversation.
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () => withUsage({ input: 100_000, output: 500, cacheRead: 0 }),
    })
    const first = (await handler(event(), ctx)) as any
    assert.equal(first.compaction.summary, "MOCK SUMMARY")
    assert.equal(calls.complete.length, 1)

    // Cache miss is diagnostic only; the next compaction still runs.
    const second = (await handler(event(), ctx)) as any
    assert.equal(second.compaction.summary, "MOCK SUMMARY")
    assert.equal(calls.complete.length, 2, "cache miss changed future compaction behavior")
    assert.ok(
      readRecords(debugFile).some((r) => r.kind === "summary_result" && r.cacheRead === 0),
      "cache miss was not retained as diagnostics",
    )
  } finally {
    ws.cleanup()
  }
})

test("the persisted summary carries Pi's file appendix and details", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx } = setup({ cwd: ws.cwd })
    const result = (await handler(
      event({
        preparation: {
          firstKeptEntryId: "keep-1",
          tokensBefore: 1234,
          turnPrefixMessages: [],
          fileOps: {
            read: new Set(["read.ts"]),
            written: new Set(["new.ts"]),
            edited: new Set(["edited.ts"]),
          },
        } as any,
      }),
      ctx,
    )) as any

    assert.deepEqual(result.compaction.details, {
      readFiles: ["read.ts"],
      modifiedFiles: ["edited.ts", "new.ts"],
    })
    assert.match(
      result.compaction.summary,
      /MOCK SUMMARY\n\n<read-files>\nread\.ts\n<\/read-files>\n\n<modified-files>\nedited\.ts\nnew\.ts\n<\/modified-files>$/,
    )
  } finally {
    ws.cleanup()
  }
})

test("a split turn asks for Pi's two-part artifact", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    const { handler, ctx, calls } = setup({ cwd: ws.cwd })
    await handler(
      event({
        preparation: {
          firstKeptEntryId: "keep-1",
          tokensBefore: 1234,
          turnPrefixMessages: [{ role: "user", content: "the turn that got cut" }],
        } as any,
      }),
      ctx,
    )
    const askText = calls.complete[0].context.messages.at(-1).content[0].text
    assert.match(askText, /\*\*Turn Context \(split turn\):\*\*/)
    assert.match(askText, /^## Original Request$/m)
    // Still a continuation: the request carries the live messages plus the ask.
    assert.equal(calls.complete[0].context.messages.length, 5)
  } finally {
    ws.cleanup()
  }
})

test("a cold cache miss does not suppress the unusable-summary retry", async () => {
  const ws = tempWorkspace()
  process.env.PI_CODING_AGENT_DIR = ws.agentDir
  try {
    // Cache usage is diagnostic only, so even a large cold request gets the same
    // one deterministic retry as a cache hit.
    const { handler, ctx, calls } = setup({
      cwd: ws.cwd,
      response: async () =>
        withUsage({
          input: 100_000,
          output: 5,
          cacheRead: 0,
          content: [{ type: "thinking", thinking: "deliberating" }],
        } as any),
    })
    assert.equal(await handler(event(), ctx), undefined)
    assert.equal(calls.complete.length, 2, "cache miss incorrectly suppressed the retry")
  } finally {
    ws.cleanup()
  }
})

/**
 * End-to-end test: a real Pi process, this extension loaded from source, and a
 * mock OpenAI-compatible model server that records every request body.
 *
 * The point is the summary call. Pi's default summary is a cold, re-serialized
 * prompt; ours must be a continuation of the live conversation. The assertions
 * below prove that directly, by checking the recorded HTTP bodies:
 *
 *   1. the summarization request keeps the conversation's system prompt and
 *      declares the same tools (Pi's default declares none);
 *   2. its message list starts with the exact prefix of the previous agent
 *      request — i.e. a prefix-caching server would serve it from cache;
 *   3. the summary it returns is the one Pi then persists.
 *
 * Runs automatically under `npm test`; `npm run test:e2e` is a focused alias. Needs no network or credentials.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { rollingMessageHashes, sharedPrefixLength } from "../src/debug.ts"
import { PRESERVE_RECOVERY_SYSTEM_PROMPT } from "../src/build.ts"

const enabled =
  process.env.PI_CACHE_COMPACT_E2E === "1" ||
  process.env.npm_lifecycle_event === "test:e2e" ||
  process.env.npm_lifecycle_event === "test"
const here = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.resolve(here, "../src/extension.ts")

const MARKER = "PI_CC_TOOLS"
const SUMMARY_TEXT = "MOCK SUMMARY: objective, files changed, next steps."

const cliPath = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  "bundle",
  "cli.js",
)

type Recorded = { body: any; headers: http.IncomingHttpHeaders }

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("\n")
  }
  return ""
}

function lastMessage(body: any): any {
  return [...(body?.messages ?? [])].reverse()[0]
}

function startMockModel(
promptTokens = 910,
options: {
lengthOnceWhen?: (body: any, requestIndex: number) => boolean
lengthPromptTokens?: number
} = {},
) {
const requests: Recorded[] = []
let toolCalls = 0
let lengthResponses = 0

  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model" }] }))
        return
      }
      if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(404).end()
        return
      }

      let body: any = {}
      try {
        body = JSON.parse(raw || "{}")
      } catch {
        /* ignore */
      }
      const requestIndex = requests.length
      requests.push({ body, headers: req.headers })

      const model = body.model ?? "test-model"
      const last = lastMessage(body)
      const lastText = textOf(last?.content)
      const isSummary =
        last?.role === "user" &&
        (/(handoff|context checkpoint) summary/i.test(lastText) ||
          /technical checkpoint ONLY from tool activity/i.test(lastText) ||
          /technical tool-context checkpoint/i.test(lastText))
      const wantsTool =
      !isSummary &&
      last?.role === "user" &&
      lastText.includes(MARKER) &&
      Array.isArray(body.tools)
      const shouldLength =
      !isSummary &&
      lengthResponses === 0 &&
      options.lengthOnceWhen?.(body, requestIndex) === true
      if (shouldLength) lengthResponses += 1
      const effectivePromptTokens =
      shouldLength && options.lengthPromptTokens !== undefined
      ? options.lengthPromptTokens
      : promptTokens
      const usage = {
      prompt_tokens: effectivePromptTokens,
      completion_tokens: shouldLength ? 1 : 10,
      total_tokens: effectivePromptTokens + (shouldLength ? 1 : 10),
      }
      const toolCallId = `call_${toolCalls + 1}`
      const summaryText = `${SUMMARY_TEXT} #${toolCalls}`

      const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
      const chunk = (choices: any[], extra: any = {}) => ({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        created: Date.now(),
        model,
        choices,
        ...extra,
      })

      if (body.stream === false) {
      res.writeHead(200, { "content-type": "application/json" })
      const message = isSummary
      ? { role: "assistant", content: summaryText }
      : shouldLength
      ? { role: "assistant", content: "I" }
      : wantsTool
      ? {
      role: "assistant",
      content: null,
      tool_calls: [
      {
      id: toolCallId,
      type: "function",
      function: { name: "read", arguments: '{"path":"probe.txt"}' },
      },
      ],
      }
      : { role: "assistant", content: "done" }
      res.end(
      JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: Date.now(),
      model,
      choices: [
      {
      index: 0,
      message,
      finish_reason: shouldLength ? "length" : wantsTool ? "tool_calls" : "stop",
      },
      ],
      usage,
      }),
      )
      return
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })

      if (shouldLength) {
      res.write(
      sse(
      chunk([{ index: 0, delta: { role: "assistant", content: "I" }, finish_reason: null }]),
      ),
      )
      res.write(sse(chunk([{ index: 0, delta: {}, finish_reason: "length" }], { usage })))
      res.write("data: [DONE]\n\n")
      res.end()
      return
      }

      if (wantsTool) {
      toolCalls++
        res.write(
          sse(
            chunk([
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: toolCallId,
                      type: "function",
                      function: { name: "read", arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ]),
          ),
        )
        res.write(
          sse(
            chunk([
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '{"path":"probe.txt"}' } }],
                },
                finish_reason: null,
              },
            ]),
          ),
        )
        res.write(sse(chunk([{ index: 0, delta: {}, finish_reason: "tool_calls" }], { usage })))
        res.write("data: [DONE]\n\n")
        res.end()
        return
      }

      const text = isSummary ? summaryText : "done"
      res.write(
        sse(
          chunk([{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]),
        ),
      )
      res.write(sse(chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { usage })))
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })

  return new Promise<{ baseURL: string; requests: Recorded[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      resolve({
        baseURL: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => server.close(),
      })
    })
  })
}

function runPi(
  mock: { baseURL: string },
  options: {
    debugFile?: string
    thinking?: string
    preserveDialogue?: boolean
    root?: string
    prompt?: string
    probeContent?: string
    contextWindow?: number
  } = {},
): Promise<{
  code: number | null
  stdout: string
  stderr: string
  agentDir: string
  root: string
  cleanup: () => void
}> {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-cache-compact-e2e-"))
  const project = path.join(root, "project")
  const agentDir = path.join(root, "agent")
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(project, "probe.txt"), options.probeContent ?? "hello probe\n")
  if (options.debugFile) {
    fs.writeFileSync(
      path.join(agentDir, "cache-compact.json"),
      JSON.stringify({
        debug: true,
        debugFile: options.debugFile,
        debugPayloads: true,
        ...(options.preserveDialogue !== undefined
          ? { preserveDialogue: options.preserveDialogue }
          : undefined),
      }),
    )
  }

  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        mock: {
          baseUrl: mock.baseURL,
          api: "openai-completions",
          apiKey: "test",
          // supportsReasoningEffort would auto-detect off for a localhost URL;
          // force it so live requests carry reasoning_effort and the summary
          // request's mirroring of it is actually exercised.
          compat: { supportsReasoningEffort: true },
          // Configured provider headers: sent on every live request by pi and
          // on our summary request through the same model, proving the mock
          // records headers so the header-replay assertions mean something.
          headers: { "x-e2e-pin": "pin-42" },
          models: [
            {
              id: "test-model",
              name: "Mock",
              reasoning: true,
              contextWindow: options.contextWindow ?? 3000,
              maxTokens: 512,
            },
          ],
        },
      },
    }),
  )
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultModel: "mock/test-model",
      compaction: { enabled: true, reserveTokens: 2100, keepRecentTokens: 10 },
    }),
  )

  const args = [
    cliPath,
    "--print",
    ...(options.root ? [["--", "continue"].join("")] : []),
    options.prompt ?? `${MARKER} list the files in the working directory`,
    "--model",
    "mock/test-model",
    ...(options.thinking ? ["--thinking", options.thinking] : []),
    "--extension",
    extensionPath,
  ]
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: project,
      env,
      // Close stdin: print mode otherwise waits on the pipe forever.
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, 120_000)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout,
        stderr,
        agentDir,
        root,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
      })
    })
  })
}

function dump(requests: Recorded[]): string {
  return requests
    .map((request, index) => {
      const body = request.body
      const roles = (body?.messages ?? []).map((message: any) => message.role).join(",")
      const tail = textOf(lastMessage(body)?.content).slice(0, 80).replace(/\n/g, " ")
      return `#${index} tools=${body?.tools?.length ?? 0} stream=${body?.stream} roles=[${roles}] last="${tail}"`
    })
    .join("\n")
}

test(
  "summarizes as a cache-hit continuation instead of a cold prompt",
  { skip: enabled ? false : "set PI_CACHE_COMPACT_E2E=1 to run (spawns pi)", timeout: 180_000 },
  async () => {
    const mock = await startMockModel()
    const debugFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-cache-compact-debug-")),
      "debug.jsonl",
    )
    let run: Awaited<ReturnType<typeof runPi>> | undefined
    try {
      run = await runPi(mock, { debugFile, thinking: "low", preserveDialogue: false })
      const context = `pi exited with ${run.code}\n--- stderr ---\n${run.stderr}\n--- requests ---\n${dump(mock.requests)}`

      const summaryReq = mock.requests.find(
        (request) =>
          lastMessage(request.body)?.role === "user" &&
          /(handoff|context checkpoint) summary/i.test(textOf(lastMessage(request.body).content)),
      )
      assert.ok(summaryReq, `extension never sent a summarization request\n${context}`)

      const summaryIndex = mock.requests.indexOf(summaryReq)
      const previous = mock.requests[summaryIndex - 1]
      assert.ok(previous, `no request before the summarization\n${context}`)

      if (process.env.E2E_DEBUG) {
        for (const [index, request] of mock.requests.entries()) {
          const systems = (request.body.messages ?? [])
            .map((message: any, messageIndex: number) =>
              message.role === "system"
                ? `${messageIndex}:${String(message.content).length}`
                : undefined,
            )
            .filter(Boolean)
          console.error(
            `#${index} roles=[${(request.body.messages ?? []).map((m: any) => m.role).join(",")}] system@${systems.join(",")}`,
          )
        }
        const a = String(summaryReq.body.messages[0]?.content ?? "")
        const b = String(previous.body.messages[0]?.content ?? "")
        let i = 0
        while (i < a.length && i < b.length && a[i] === b[i]) i++
        console.error(`system prompt: previous=${b.length} summary=${a.length} diverge@${i}`)
        console.error("previous ctx:", JSON.stringify(b.slice(Math.max(0, i - 80), i + 160)))
        console.error("summary  ctx:", JSON.stringify(a.slice(Math.max(0, i - 80), i + 160)))
      }

      // Reasoning effort is rendered into the prompt on some servers, so the
      // summary ask must carry exactly the effort the live prefix was sent
      // with (here: mirrored from --thinking low through the real hook).
      assert.equal(
        previous.body.reasoning_effort,
        "low",
        "live request should carry reasoning_effort",
      )
      assert.equal(summaryReq.body.reasoning_effort, previous.body.reasoning_effort)

      // Wire-level header identity: configured provider headers must be on
      // the summary request exactly as on the live one — the ask has to be a
      // transport-level twin, not just a body-level twin.
      assert.equal(previous.headers["x-e2e-pin"], "pin-42", "live request lost configured headers")
      assert.equal(
        summaryReq.headers["x-e2e-pin"],
        "pin-42",
        "summary request did not send configured headers",
      )

      // Same system prompt as the conversation, not Pi's summarization prompt.
      assert.equal(
        (summaryReq.body.messages[0] ?? {}).content,
        (previous.body.messages[0] ?? {}).content,
        `summarization did not reuse the conversation system prompt\n${context}`,
      )

      // Tools are still declared, so the prompt prefix is unchanged.
      assert.ok(
        Array.isArray(summaryReq.body.tools) && summaryReq.body.tools.length > 0,
        `summarization request declared no tools\n${context}`,
      )

      // The summarization request must end with the ask, and everything before
      // it must be the *complete* previous live request — a strict forward
      // continuation. Rewinding to just the dropped span is what an append-only
      // server cache (llama.cpp slots) answers with a full re-prefill, so the
      // tail must be present. This assertion is the inverse of the one it
      // replaced: the old shape was guarded in the other direction.
      const requestMessages = summaryReq.body.messages
      const last = requestMessages[requestMessages.length - 1]
      assert.equal(last?.role, "user", `summarization must end with a user ask\n${context}`)
      const askText = textOf(last?.content)
      assert.match(askText, /(handoff|context checkpoint) summary/i)
      const continuation = requestMessages.slice(0, -1)
      assert.ok(
        continuation.length > previous.body.messages.length,
        `summarization did not continue the live request (sent ${continuation.length} messages, live had ${previous.body.messages.length})\n${context}`,
      )
      assert.deepEqual(
        previous.body.messages,
        continuation.slice(0, previous.body.messages.length),
        `the live request is not a prefix of the summarization request\n${context}`,
      )
      // ...while the summary *text* is still scoped to the dropped span: the ask
      // names the boundary so the kept tail is not described twice.
      assert.match(askText, /stay in the context verbatim/, `ask lost its scope note\n${context}`)

      // Pi's default serialization must not be involved.
      assert.doesNotMatch(JSON.stringify(summaryReq.body), /<conversation>/)

      // The summary we generated is what Pi persisted as the compaction entry.
      const agentDir = run.agentDir
      const sessionText = fs
        .readdirSync(agentDir, { recursive: true })
        .filter((file) => String(file).endsWith(".jsonl"))
        .map((file) => fs.readFileSync(path.join(agentDir, String(file)), "utf8"))
        .join("\n")
      assert.match(
        sessionText,
        /"type":\s*"compaction"/,
        `no compaction entry persisted\n${context}`,
      )
      assert.ok(sessionText.includes(SUMMARY_TEXT), `extension summary not persisted\n${context}`)

      // Debug records: every provider request (live turns and the
      // summarization call) must be fingerprinted, the summary request must
      // be tagged, and its rolling hashes must share a prefix with the
      // previous live request — the machine-readable cache assertion.
      const records = fs
        .readFileSync(debugFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as any)
      const providerRequests = records.filter((record) => record.kind === "provider_request")
      assert.ok(
        providerRequests.length >= 2,
        `expected fingerprints for live + summary requests, got ${providerRequests.length}\n${context}`,
      )
      const summaryRecord = providerRequests.find((record) => record.summary === true)
      assert.ok(
        summaryRecord,
        `no provider_request tagged summary=true\n${JSON.stringify(providerRequests, null, 1)}`,
      )
      // Documents which branch built the system prompt for this run; both
      // branches must keep the prefix, but production uses "recorded".
      assert.ok(["recorded", "synthesized"].includes(summaryRecord.systemSource))
      assert.equal(summaryRecord.model, "test-model")
      assert.ok(summaryRecord.toolsCount > 0, `summary request fingerprint has no tools`)
      const summaryRecordIndex = providerRequests.indexOf(summaryRecord)
      const previousLive = providerRequests[summaryRecordIndex - 1]
      assert.ok(previousLive && previousLive.summary !== true, `no live request before the summary`)
      const shared = sharedPrefixLength(previousLive.rolling, summaryRecord.rolling)
      assert.ok(
        shared >= 1,
        `summary request shares no message prefix with the previous live request (cache would miss):\n${JSON.stringify(
          { previous: previousLive.rolling, summary: summaryRecord.rolling },
          null,
          1,
        )}`,
      )
      // The whole live request must be reusable from cache, not a shared
      // fraction of it: on an append-only cache the request is either a
      // forward continuation of the checkpoint or it re-prefills, so "shared
      // most of it" is not a hit. `shared === previous.rolling.length` says the
      // live request is a strict prefix of the ask; the extra entry is the ask.
      assert.equal(
        summaryRecord.requestShape,
        "continuation",
        `summary request used the rewinding shape`,
      )
      assert.equal(
        shared,
        previousLive.rolling.length,
        `summary request does not continue the whole live request (shared ${shared} of ${previousLive.rolling.length})`,
      )
      assert.ok(
        summaryRecord.rolling.length > previousLive.rolling.length,
        `summary request is not longer than the live prefix it continues`,
      )
      if (process.env.PI_E2E_VERBOSE) {
        console.error("[e2e] summaryRecord:", JSON.stringify(summaryRecord, null, 1))
        console.error("[e2e] sharedPrefix:", shared, "of", previousLive.rolling.length)
      }
      const summaryDone = records.find((record) => record.kind === "summary_result")
      assert.ok(summaryDone, `no summary_result record`)

      // Header observability: live and summary sides must both be recorded
      // so request identity invisible in payload dumps can be diffed after
      // the fact (replica routing headers, affinity keys, cache echoes).
      const headerRecords = records.filter((record) => record.kind === "provider_headers")
      assert.ok(
        headerRecords.find((r) => r.summary === false),
        `no live provider_headers record`,
      )
      const summaryHeaderRecord = headerRecords.find((r) => r.summary === true)
      assert.ok(summaryHeaderRecord, `no summary provider_headers record`)
      assert.equal(
        summaryHeaderRecord.liveCaptured,
        true,
        `summary ask did not observe a live request`,
      )
      const responseRecords = records.filter((record) => record.kind === "provider_response")
      assert.ok(
        responseRecords.find((r) => r.summary === false),
        `no live provider_response record (after_provider_response never fired)`,
      )
      const summaryResponseRecord = responseRecords.find((r) => r.summary === true)
      assert.ok(
        summaryResponseRecord,
        `no summary provider_response record (onResponse never fired)`,
      )
      assert.equal(summaryResponseRecord.status, 200)

      // Full payload dumps: the last live request before compaction and our
      // summarization request, as rendered by real pi-ai. Run the shipped
      // compare script over them — the same tool a human would use.
      const dumps = records.filter((record) => record.kind === "payload_dump")
      const dumpVariants = new Set(dumps.map((record) => record.variant))
      assert.ok(dumpVariants.has("live_before"), `no live_before dump; got ${[...dumpVariants]}`)
      assert.ok(
        dumpVariants.has("summarization"),
        `no summarization dump; got ${[...dumpVariants]}`,
      )
      const dumpFile = path.join(path.dirname(debugFile), "dump-out.txt")
      const script = fileURLToPath(new URL("../scripts/compare-dumps.mjs", import.meta.url))
      const { execFileSync } = await import("node:child_process")
      try {
        fs.writeFileSync(dumpFile, execFileSync("node", [script, debugFile], { encoding: "utf8" }))
      } catch (error) {
        const stdout = String((error as any).stdout ?? "")
        fs.writeFileSync(dumpFile, stdout)
        // Exit 1 means divergence found beyond the shared prefix; that is
        // allowed (the kept tail vs the ask), but a zero shared prefix is not.
        assert.match(
          stdout,
          /shared prefix=[1-9]/,
          `compare-dumps reported no shared prefix:\n${stdout}`,
        )
        throw error
      }
      const compareOut = fs.readFileSync(dumpFile, "utf8")
      assert.match(compareOut, /shared prefix=[1-9]/, compareOut)
    } finally {
      mock.close()
      run?.cleanup()
    }
  },
)

test(
"certification: preserve recovery rewind keeps the exact technical delta and rebuilds the next live context",
{ skip: enabled ? false : "set PI_CACHE_COMPACT_E2E=1 to run (spawns pi)", timeout: 180_000 },
async () => {
const firstOutput = "FIRST RECOVERY-CERT TOOL OUTPUT\n"
const recoveryOutput = "RECOVERY TOOL OUTPUT\n" + "r".repeat(40_000)
const mock = await startMockModel(37_000, {
lengthPromptTokens: 56_172,
lengthOnceWhen: (body) => {
const serialized = JSON.stringify(body?.messages ?? [])
const ask = textOf(lastMessage(body)?.content)
return (
serialized.includes("## Tool Context Checkpoint #1") &&
serialized.includes("RECOVERY TOOL OUTPUT") &&
!/technical checkpoint ONLY from tool activity/i.test(ask) &&
!/technical tool-context checkpoint/i.test(ask)
)
},
})
const debugFile = path.join(
fs.mkdtempSync(path.join(os.tmpdir(), "pi-cache-compact-recovery-")),
"debug.jsonl",
)
const firstPrompt = `${MARKER} RECOVERY CERT USER 1: preserve exactly`
const secondPrompt = `${MARKER} RECOVERY CERT USER 2: preserve exactly`
const finalPrompt = "RECOVERY CERT FINAL PROBE"
let run: Awaited<ReturnType<typeof runPi>> | undefined
try {
run = await runPi(mock, {
debugFile,
thinking: "low",
preserveDialogue: true,
contextWindow: 50_000,
prompt: firstPrompt,
probeContent: firstOutput,
})
const root = run.root
run = await runPi(mock, {
debugFile,
thinking: "low",
preserveDialogue: true,
contextWindow: 50_000,
root,
prompt: secondPrompt,
probeContent: recoveryOutput,
})
const recoveryRun = run
run = await runPi(mock, {
debugFile,
thinking: "low",
preserveDialogue: true,
contextWindow: 50_000,
root,
prompt: finalPrompt,
})

const context = `recovery run exited with ${recoveryRun.code}; final run exited with ${run.code}\n--- recovery stderr ---\n${recoveryRun.stderr}\n--- final stderr ---\n${run.stderr}\n--- requests ---\n${dump(mock.requests)}`
const isToolSummaryRequest = (request: Recorded | undefined): boolean =>
Boolean(
request &&
(/technical checkpoint ONLY from tool activity/i.test(
textOf(lastMessage(request.body)?.content),
) ||
/technical tool-context checkpoint/i.test(textOf(lastMessage(request.body)?.content))),
)
const summaryIndexes = mock.requests
.map((request, index) => (isToolSummaryRequest(request) ? index : -1))
.filter((index) => index >= 0)
assert.equal(
summaryIndexes.length,
2,
`expected normal checkpoint + recovery checkpoint, got ${summaryIndexes.length}\n${context}`,
)

const firstSummaryIndex = summaryIndexes[0]
const recoverySummaryIndex = summaryIndexes[1]
const firstSummaryReq = mock.requests[firstSummaryIndex]
const recoveryReq = mock.requests[recoverySummaryIndex]
const preRecoveryLive = mock.requests[recoverySummaryIndex - 1]
assert.ok(preRecoveryLive, `no oversized live request before recovery\n${context}`)

// Checkpoint #1 remains the normal cache-friendly path: it summarizes the old
// batch and deliberately leaves the second batch raw.
assert.notEqual(textOf(firstSummaryReq.body.messages?.[0]?.content), PRESERVE_RECOVERY_SYSTEM_PROMPT)
assert.ok(JSON.stringify(firstSummaryReq.body.messages).includes("FIRST RECOVERY-CERT TOOL OUTPUT"))
assert.ok(!JSON.stringify(firstSummaryReq.body.messages).includes("RECOVERY TOOL OUTPUT"))
assert.deepEqual(
mock.requests[firstSummaryIndex - 1].body.messages,
firstSummaryReq.body.messages.slice(0, mock.requests[firstSummaryIndex - 1].body.messages.length),
)

// The next live request contains checkpoint #1 + the carried raw second batch
// and is the request the mock intentionally terminates with finish_reason=length.
const preRecoverySerialized = JSON.stringify(preRecoveryLive.body.messages)
assert.ok(preRecoverySerialized.includes("## Tool Context Checkpoint #1"))
assert.ok(preRecoverySerialized.includes("RECOVERY TOOL OUTPUT"))
assert.ok(preRecoverySerialized.includes("call_2"))

// Recovery is intentionally cold and minimal: only a tiny recovery system
// message, the exact technical delta, and the synthetic checkpoint ask.
assert.equal(textOf(recoveryReq.body.messages?.[0]?.content), PRESERVE_RECOVERY_SYSTEM_PROMPT)
const recoveryRoles = recoveryReq.body.messages.map((message: any) => message.role)
assert.ok(
recoveryRoles[0] === "system" || recoveryRoles[0] === "developer",
`recovery instruction used unexpected provider role ${recoveryRoles[0]}`,
)
assert.deepEqual(
recoveryRoles.slice(1),
["assistant", "tool", "user"],
"recovery request must contain only instruction + exact tool delta + checkpoint ask",
)
assert.ok(!Array.isArray(recoveryReq.body.tools) || recoveryReq.body.tools.length === 0)
assert.ok(!JSON.stringify(recoveryReq.body.messages).includes(firstPrompt))
assert.ok(!JSON.stringify(recoveryReq.body.messages).includes(secondPrompt))
assert.ok(!JSON.stringify(recoveryReq.body.messages).includes("FIRST RECOVERY-CERT TOOL OUTPUT"))
assert.ok(!JSON.stringify(recoveryReq.body.messages).includes(SUMMARY_TEXT))
assert.equal(
recoveryReq.body.messages.some((message: any) => textOf(message.content) === "I"),
false,
"truncated current assistant leaked into the recovery delta",
)

const recoveryToolCall = recoveryReq.body.messages.find(
(message: any) =>
message.role === "assistant" &&
Array.isArray(message.tool_calls) &&
message.tool_calls.some((call: any) => call.id === "call_2"),
)
assert.ok(recoveryToolCall, `recovery request lost call_2\n${context}`)
assert.equal(recoveryToolCall.tool_calls[0].function.name, "read")
assert.equal(JSON.parse(recoveryToolCall.tool_calls[0].function.arguments).path, "probe.txt")
const recoveryToolResult = recoveryReq.body.messages.find(
(message: any) => message.role === "tool" && message.tool_call_id === "call_2",
)
assert.ok(recoveryToolResult, `recovery request lost call_2 result\n${context}`)
const recoveryToolText = textOf(recoveryToolResult.content)
assert.ok(recoveryToolText.includes("RECOVERY TOOL OUTPUT"))
assert.ok(
recoveryToolText.includes("r".repeat(40_000)),
"recovery request truncated the tool result instead of summarizing the exact delta",
)
const recoveryAsk = textOf(lastMessage(recoveryReq.body)?.content)
assert.match(recoveryAsk, /NEW compact incremental technical checkpoint/i)
assert.match(recoveryAsk, /absolute user-message ordinal\(s\): 2(?:\D|$)/)

// The next ordinary provider request must use the rebuilt model state. It may
// happen immediately or on the explicit final probe, but it must exist.
const postRecoveryLive = mock.requests
.slice(recoverySummaryIndex + 1)
.find((request) => !isToolSummaryRequest(request))
assert.ok(postRecoveryLive, `no ordinary live request after recovery checkpoint\n${context}`)
const postMessages = postRecoveryLive.body.messages ?? []
const postSerialized = JSON.stringify(postMessages)
assert.ok(postSerialized.includes(firstPrompt))
assert.ok(postSerialized.includes(secondPrompt))
assert.ok(postSerialized.includes("## Tool Context Checkpoint #1"))
assert.ok(postSerialized.includes("## Tool Context Checkpoint #2"))
assert.ok(!postSerialized.includes("FIRST RECOVERY-CERT TOOL OUTPUT"))
assert.ok(!postSerialized.includes("RECOVERY TOOL OUTPUT"))
assert.ok(!postSerialized.includes("call_1"))
assert.ok(!postSerialized.includes("call_2"))
assert.ok(
postMessages.some((message: any) => message.role === "assistant" && textOf(message.content) === "I"),
"current length-stopped assistant tail should remain raw after recovery",
)
const postMaxTokens = postRecoveryLive.body.max_tokens ?? postRecoveryLive.body.max_completion_tokens
assert.equal(typeof postMaxTokens, "number")
assert.ok(postMaxTokens > 1, `post-recovery response was clamped to ${postMaxTokens}\n${context}`)

// Everything before the compacted raw second batch must remain byte-for-byte
// identical. The first divergence is the raw call/result being replaced by CP2.
const beforeHashes = rollingMessageHashes(preRecoveryLive.body.messages ?? [])
const afterHashes = rollingMessageHashes(postMessages)
const shared = sharedPrefixLength(beforeHashes, afterHashes)
assert.ok(shared > 0, `recovery rebuilt context shares no stable prefix\n${context}`)
assert.deepEqual(
(preRecoveryLive.body.messages ?? []).slice(0, shared),
postMessages.slice(0, shared),
"recovery damaged provider messages before the compacted delta",
)
const firstRemoved = JSON.stringify((preRecoveryLive.body.messages ?? [])[shared] ?? {})
assert.match(
firstRemoved,
 /call_2|RECOVERY TOOL OUTPUT/,
`first divergence is not the compacted technical delta: ${firstRemoved}`,
)

// The explicit final probe proves Pi can continue normally from the rebuilt state.
assert.equal(run.code, 0, context)
const finalLive = [...mock.requests]
.reverse()
.find(
(request) =>
lastMessage(request.body)?.role === "user" &&
textOf(lastMessage(request.body)?.content) === finalPrompt,
)
assert.ok(finalLive, `no final live request after recovery\n${context}`)
const finalSerialized = JSON.stringify(finalLive.body.messages)
assert.ok(finalSerialized.includes(firstPrompt))
assert.ok(finalSerialized.includes(secondPrompt))
assert.ok(finalSerialized.includes("## Tool Context Checkpoint #1"))
assert.ok(finalSerialized.includes("## Tool Context Checkpoint #2"))
assert.ok(!finalSerialized.includes("RECOVERY TOOL OUTPUT"))
assert.ok(!finalSerialized.includes("call_2"))
assert.match(run.stdout, /done/i)

// Raw transcript stays append-only even though the provider context is compact.
const sessionText = fs
.readdirSync(run.agentDir, { recursive: true })
.filter((file) => String(file).endsWith(".jsonl"))
.map((file) => fs.readFileSync(path.join(run!.agentDir, String(file)), "utf8"))
.join("\n")
assert.ok(sessionText.includes(firstOutput.trim()))
assert.ok(sessionText.includes("RECOVERY TOOL OUTPUT"))
assert.ok(sessionText.includes("call_2"))
assert.ok(sessionText.includes("cache-compact-preserve-checkpoint"))
assert.doesNotMatch(sessionText, /"type":"compaction"/)

// Debug audit certifies the branch actually used recovery-rewind and that the
// first live payload after CP2 is the context Pi really sent to the provider.
const debugRecords = fs
.readFileSync(debugFile, "utf8")
.split("\n")
.filter(Boolean)
.map((line) => JSON.parse(line) as any)
const summaryStarts = debugRecords.filter((record) => record.kind === "summary_start")
assert.equal(summaryStarts.length, 2)
assert.notEqual(summaryStarts[0].requestShape, "recovery-rewind")
assert.equal(summaryStarts[1].requestShape, "recovery-rewind")
const compactions = debugRecords.filter((record) => record.kind === "preserve_compaction")
assert.equal(compactions.length, 2)
assert.equal(compactions[1].checkpoint.number, 2)
assert.deepEqual(compactions[1].checkpoint.coveredUserMessages, [2])
assert.ok(JSON.stringify(compactions[1].contextBefore).includes("RECOVERY TOOL OUTPUT"))
assert.ok(!JSON.stringify(compactions[1].contextAfter).includes("RECOVERY TOOL OUTPUT"))
assert.ok(JSON.stringify(compactions[1].contextAfter).includes("I"))
// Recovery ends the length-stopped print run, so the next live request is made
// by the resumed Pi process. The mock capture above is therefore the actual
// provider-level certification; the in-memory post_compaction_context marker
// cannot survive that process boundary.
assert.ok(postMessages.length > 0)
} finally {
mock.close()
run?.cleanup()
}
},
)

test(
"certification: preserveDialogue keeps dialogue verbatim and leaves the newest tool batch raw",
  { skip: enabled ? false : "set PI_CACHE_COMPACT_E2E=1 to run (spawns pi)", timeout: 180_000 },
  async () => {
    const mock = await startMockModel(37_000)
    const debugFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "pi-cache-compact-preserve-")),
      "debug.jsonl",
    )
    const firstPrompt = `${MARKER} FIRST USER REQUIREMENT: preserve this exact text`
    const secondPrompt = `${MARKER} SECOND USER REQUIREMENT: preserve this exact text`
    const thirdPrompt = `${MARKER} THIRD USER REQUIREMENT: preserve this exact text`
    const finalPrompt = "CERTIFICATION FINAL PROBE"
    let run: Awaited<ReturnType<typeof runPi>> | undefined
    try {
      run = await runPi(mock, {
        debugFile,
        thinking: "low",
        preserveDialogue: true,
        contextWindow: 50_000,
        prompt: firstPrompt,
        probeContent: "FIRST TOOL OUTPUT\n",
      })
      const root = run.root
      run = await runPi(mock, {
        debugFile,
        thinking: "low",
        preserveDialogue: true,
        contextWindow: 50_000,
        root,
        prompt: secondPrompt,
        probeContent: "SECOND TOOL OUTPUT\n" + "x".repeat(40_000),
      })
      run = await runPi(mock, {
        debugFile,
        thinking: "low",
        preserveDialogue: true,
        contextWindow: 50_000,
        root,
        prompt: thirdPrompt,
        probeContent: "THIRD TOOL OUTPUT\n" + "y".repeat(40_000),
      })
      run = await runPi(mock, {
        debugFile,
        thinking: "low",
        preserveDialogue: true,
        contextWindow: 50_000,
        root,
        prompt: finalPrompt,
      })

      const context = `pi exited with ${run.code}\n--- stderr ---\n${run.stderr}\n--- requests ---\n${dump(mock.requests)}`
      const isToolSummaryRequest = (request: Recorded | undefined): boolean =>
        Boolean(
          request &&
          (/technical checkpoint ONLY from tool activity/i.test(
            textOf(lastMessage(request.body)?.content),
          ) ||
            /technical tool-context checkpoint/i.test(textOf(lastMessage(request.body)?.content))),
        )
      const summaryIndexes = mock.requests
        .map((request, index) =>
          isToolSummaryRequest(request) && !isToolSummaryRequest(mock.requests[index - 1])
            ? index
            : -1,
        )
        .filter((index) => index >= 0)

      assert.equal(
        summaryIndexes.length,
        2,
        `expected two checkpoints: each new tool batch compacts only the previous raw batch; got ${summaryIndexes.length}\n${context}`,
      )

      const expectedCompactedOutputs = ["FIRST TOOL OUTPUT", "SECOND TOOL OUTPUT"]
      for (const [ordinal, summaryIndex] of summaryIndexes.entries()) {
        const summaryReq = mock.requests[summaryIndex]
        const previous = mock.requests[summaryIndex - 1]
        assert.ok(previous, `no live request before summary #${summaryIndex}\n${context}`)
        assert.deepEqual(
          previous.body.messages,
          summaryReq.body.messages.slice(0, previous.body.messages.length),
          `summary #${summaryIndex} is not a strict continuation of the cached provider prefix\n${context}`,
        )
        assert.deepEqual(previous.body.tools, summaryReq.body.tools)
        assert.equal(summaryReq.body.reasoning_effort, previous.body.reasoning_effort)
        const serialized = JSON.stringify(summaryReq.body.messages)
        assert.ok(serialized.includes(expectedCompactedOutputs[ordinal]))
        const newestRaw = ordinal === 0 ? "SECOND TOOL OUTPUT" : "THIRD TOOL OUTPUT"
        assert.ok(
          !serialized.includes(newestRaw),
          `summary #${summaryIndex} included the triggering raw tool batch\n${context}`,
        )
        for (let prior = 0; prior < ordinal; prior++) {
          assert.ok(!serialized.includes(expectedCompactedOutputs[prior]))
        }
        const ask = textOf(lastMessage(summaryReq.body)?.content)
        assert.match(ask, /NEW compact incremental technical checkpoint/i)
        assert.match(ask, /Historical Tool Context Checkpoints are immutable preserved context/)
        assert.match(ask, /Summarize RESULTS/i)
        assert.match(
          ask,
          new RegExp(`absolute user-message ordinal\\(s\\): ${ordinal + 1}(?:\\D|$)`),
        )
        assert.equal(serialized.split(SUMMARY_TEXT).length - 1, ordinal)

        const postCheckpoint = mock.requests[summaryIndex + 1]
        assert.ok(
          postCheckpoint,
          "no live continuation after checkpoint " + (ordinal + 1) + "\n" + context,
        )
        assert.equal(
          isToolSummaryRequest(postCheckpoint),
          false,
          "checkpoint " +
            (ordinal + 1) +
            " was followed by another summary instead of a live request\n" +
            context,
        )
        const postCheckpointMaxTokens =
          postCheckpoint.body.max_tokens ?? postCheckpoint.body.max_completion_tokens
        assert.equal(typeof postCheckpointMaxTokens, "number")
        assert.ok(
          postCheckpointMaxTokens > 1,
          "post-checkpoint response was clamped to " +
            postCheckpointMaxTokens +
            " token; stale pre-checkpoint assistant usage was still treated as the current prompt\n" +
            context,
        )
      }

      const finalLive = [...mock.requests]
        .reverse()
        .find(
          (request) =>
            lastMessage(request.body)?.role === "user" &&
            textOf(lastMessage(request.body)?.content) === finalPrompt,
        )
      assert.ok(finalLive, `no live request for the final certification probe\n${context}`)

      const messages = finalLive.body.messages ?? []
      const userTexts = messages
        .filter((message: any) => message.role === "user")
        .map((message: any) => textOf(message.content))
      const assistantTexts = messages
        .filter((message: any) => message.role === "assistant")
        .map((message: any) => textOf(message.content))
        .filter(Boolean)
      assert.equal(userTexts.filter((text: string) => text === firstPrompt).length, 1)
      assert.equal(userTexts.filter((text: string) => text === secondPrompt).length, 1)
      assert.equal(userTexts.filter((text: string) => text === thirdPrompt).length, 1)
      assert.equal(assistantTexts.filter((text: string) => text === "done").length, 3)

      const rendered = JSON.stringify(messages)
      assert.equal(
        rendered.split(SUMMARY_TEXT).length - 1,
        2,
        `the two immutable technical checkpoints must remain in final context\n${context}`,
      )
      assert.ok(!rendered.includes("FIRST TOOL OUTPUT"))
      assert.ok(!rendered.includes("SECOND TOOL OUTPUT"))
      assert.ok(
        rendered.includes("THIRD TOOL OUTPUT"),
        "newest tool result must remain raw until a later tool batch crosses reserve",
      )
      assert.ok(!rendered.includes("call_1"))
      assert.ok(!rendered.includes("call_2"))
      assert.ok(
        rendered.includes("call_3"),
        "newest tool call must remain paired with its raw result",
      )

      const sessionText = fs
        .readdirSync(run.agentDir, { recursive: true })
        .filter((file) => String(file).endsWith(".jsonl"))
        .map((file) => fs.readFileSync(path.join(run!.agentDir, String(file)), "utf8"))
        .join("\n")
      assert.ok(sessionText.includes(firstPrompt))
      assert.ok(sessionText.includes(secondPrompt))
      assert.ok(sessionText.includes(thirdPrompt))
      assert.ok(sessionText.includes("FIRST TOOL OUTPUT"))
      assert.ok(sessionText.includes("SECOND TOOL OUTPUT"))
      assert.ok(sessionText.includes("THIRD TOOL OUTPUT"))
      assert.ok(sessionText.includes("cache-compact-preserve-checkpoint"))
      assert.doesNotMatch(
        sessionText,
        /\"type\":\"compaction\"/,
        "preserve checkpoints must not create Pi compaction entries that clear the TUI transcript",
      )
      assert.ok((sessionText.match(/\"mode\":\"preserve-dialogue-v1\"/g) ?? []).length >= 2)

      const debugRecords = fs
        .readFileSync(debugFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as any)
      const compactionRecords = debugRecords.filter(
        (record) => record.kind === "preserve_compaction",
      )
      assert.equal(compactionRecords.length, 2)
      assert.equal(compactionRecords[0].checkpoint.number, 1)
      assert.equal(compactionRecords[1].checkpoint.number, 2)
      assert.equal(compactionRecords[1].historicalCheckpoints.length, 1)
      assert.notEqual(
        compactionRecords[0].checkpoint.summaryHash,
        compactionRecords[1].checkpoint.summaryHash,
      )
      assert.equal(
        compactionRecords[1].historicalCheckpoints[0].hash,
        compactionRecords[0].checkpoint.summaryHash,
      )
      assert.equal(
        JSON.stringify(compactionRecords[1].contextAfter).split(SUMMARY_TEXT).length - 1,
        2,
      )
      assert.ok(JSON.stringify(compactionRecords[1].contextBefore).includes("SECOND TOOL OUTPUT"))
      assert.ok(!JSON.stringify(compactionRecords[1].contextAfter).includes("SECOND TOOL OUTPUT"))
      assert.ok(JSON.stringify(compactionRecords[1].contextAfter).includes("THIRD TOOL OUTPUT"))
      assert.ok(Array.isArray(compactionRecords[1].contextIndex.before))
      assert.ok(Array.isArray(compactionRecords[1].contextIndex.after))
      assert.ok(compactionRecords[1].scope.rawEntryCount > 0)
      assert.equal(
        compactionRecords[1].scope.rawEntryIds.length,
        compactionRecords[1].scope.rawEntryCount,
      )
      assert.ok(compactionRecords[1].tokens.providerContextBefore > 0)
      assert.ok(compactionRecords[1].tokens.estimatedContextAfter > 0)
      assert.ok(compactionRecords[1].tokens.preservedUserMessages > 0)
      assert.ok(compactionRecords[1].tokens.preservedAssistantText > 0)
      assert.ok(compactionRecords[1].tokens.compactedRaw > 0)
      assert.ok(compactionRecords[1].tokens.remainingRawCompactable > 0)
      assert.equal(
        compactionRecords[1].tokens.estimatedReclaimed,
        Math.max(
          0,
          compactionRecords[1].tokens.compactedRaw - compactionRecords[1].tokens.newCheckpoint,
        ),
      )
      assert.equal(
        compactionRecords[1].tokens.compression,
        compactionRecords[1].tokens.newCheckpoint > 0
          ? compactionRecords[1].tokens.compactedRaw / compactionRecords[1].tokens.newCheckpoint
          : null,
      )

      const postContexts = debugRecords.filter(
        (record) => record.kind === "post_compaction_context",
      )
      assert.ok(postContexts.length >= 2)
      assert.equal(postContexts.at(-1).branchCheckpoints.length, 2)
    } finally {
      mock.close()
      run?.cleanup()
    }
  },
)

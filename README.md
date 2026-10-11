<div align="center">

# 🗜️ pi-cache-compact-preserved-messages

**Cache-friendly context compaction for [Pi](https://pi.dev).**

A port of [opencode-cache-compact](https://github.com/lennartschoch/opencode-cache-compact),
adapted to Pi's extension API.

For locally hosted models, where prefilling a large context is the expensive part.

[Install](#install) · [Configure](#configure) · [How it works](#how-it-works) · [Caveats](#caveats) · [Develop](#develop)

[![npm](https://img.shields.io/npm/v/pi-cache-compact-preserved-messages?color=8B5CF6&style=flat-square)](https://www.npmjs.com/package/pi-cache-compact-preserved-messages)
![tests](https://img.shields.io/badge/tests-104-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

</div>

---

## Why

Pi's built-in compaction writes the summary with a brand-new request: its own
system prompt, no tools, and the transcript re-serialized into a single user
message. Two consequences:

1. **It can never reuse the conversation's KV cache** — a different prompt,
   so a prefix-caching server re-prefills it from nothing.
2. **It is lossy.** Before serializing, Pi truncates *every tool result to
   2,000 characters* (`TOOL_RESULT_MAX_CHARS` in its compaction utils). Measured
   on a 98k-token dropped span, Pi's request was 8,391 tokens — the summary was
   written from roughly 9% of the conversation, with the tool output capped per
   message. For a coding session, the tool output *is* the substance: file
   contents, diffs, test failures, error text.

This extension makes compaction cache-friendly while preserving Pi's emergency
threshold and overflow recovery:

1. **Reuse the live prefix.** It asks for the handoff summary as a strict
   continuation of the conversation — the same system prompt, the same tool
   declarations, the same messages — followed by one user turn asking for the
   summary, so a prefix-caching server serves everything but that short ask from
   cache.
2. **Keep the detail, because it is free.** Pi has to truncate tool results
   precisely because its request is cold. A continuation is a cache hit, so the
   prompt costs almost nothing to make large: the summary is written from the
   real messages, at full fidelity, and the only tokens evaluated are the ask.
3. **Compact preserve mode at safe turn boundaries.** After a tool-using turn
   has fully persisted its results and before the next provider request, the
   extension can write the preserve compaction boundary without aborting the run.
4. **Fail closed in preserve mode.** If a complete tool-state summary cannot be
   produced safely, the compaction is cancelled rather than losing verbatim
   dialogue. With `preserveDialogue: false`, Pi's normal fallback remains available.

**The shape is the whole trick.** Sending only the span Pi is about to drop
*looks* right — it is a prefix of the live request — but on an append-only cache
(llama.cpp's per-slot checkpoint) a shorter request is a **rewind**, and a rewind
re-prefills from scratch: a request 35 tokens shorter than the checkpoint
re-prefilled all 7710 tokens, while a continuation reused 7706/7745 in 0.4 s. So
the ask is appended to the conversation instead, and the summary's *scope* is
steered by instruction. On a server that caches arbitrary shared prefixes
(vLLM-style) both shapes hit, and `continuation: false` sends the smaller one.

## Install

Requires Pi with the `session_before_compact` extension hook (tested against
`@earendil-works/pi-coding-agent` 0.87.0). No build step — Pi loads the
TypeScript extension directly.

```bash
pi install npm:pi-cache-compact-preserved-messages
# or from a checkout, without installing anything
pi -e ./src/extension.ts
```

## Configure

Options are read from JSON, merged with the project file winning:

1. `<agent-dir>/cache-compact.json` (personal; `~/.pi/agent` by default)
2. `<cwd>/.pi/cache-compact.json` (project)

```json
{
  "models": ["local/qwen3-coder"],
  "preserveDialogue": true
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Disable the extension entirely, including preserve-mode context restoration and UI diagnostics. |
| `models` | string[] | `[]` (all) | Only run compaction handling and diagnostics on these `provider/modelId`s. Scope it to your local endpoint. |
| `summaryModel` | `{ provider, id }` | active model | Summarize with a different (e.g. cheaper) model. |
| `summaryPrompt` | string | [see `src/build.ts`](src/build.ts) | Replace the handoff instruction. In `preserveDialogue` mode a custom prompt is responsible for keeping the summary tool-only. |
| `preserveDialogue` | boolean | `true` | Keep every historical user message and visible assistant text response verbatim in future model context. Old tool results and tool calls are replaced by the generated technical summary; old thinking/reasoning is discarded rather than summarized. |
| `summaryMaxTokens` | number | derived | Cap on the summary's output tokens. By default it is **Pi's own ceiling** (`0.8 × reserveTokens`, clamped to the model's `maxTokens`) bounded by half of what this compaction drops, with a 2048 floor for thinking tokens — so a checkpoint is never larger than what it replaces. Set a number to override all of that. A reply truncated at the cap is rejected and Pi's default runs, so prefer a generous cap. |
| `summaryReasoningEffort` | `"off" \| "none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | mirror the live request | Force an effort. The default mirrors what the last live request actually sent, because the effort reaches the prompt on some servers (see Caveats). `"none"` sends `reasoning_effort: "none"`, which llama.cpp documents as disabling reasoning *without* handing the value to the chat template; `"off"` sends no field at all, leaving the server's default. Either is worth trying if a reasoning model keeps ending its turn inside its reasoning block. |
| `cacheRetention` | `"none" \| "short" \| "long"` | `"short"` | Cache retention for the summary request. |
| `toolChoice` | `"none" \| "auto"` | `"none"` | Forbid tool calls in the summary reply; tools are still declared for the prefix. |
| `deferAfterCacheMiss` | boolean | `true` | After a large continuation misses the cache, avoid immediately paying another cold full-prefix request. Normal mode can defer to Pi's small summary; preserve mode cancels rather than accepting Pi's lossy fallback. Re-arms after 15 minutes. |
| `continuation` | boolean | `true` | Send the ask as a forward continuation of the live conversation instead of a rewind to the dropped span. Normal mode may use `continuation-request` when the whole projection no longer fits. Preserve mode must cover all current tool traffic, so it requires the complete live continuation and cancels rather than silently omitting fresh tool results. `false` sends only the dropped span. |
| `rewindWhenNeeded` | boolean | `false` | When no continuation fits the context window, allow the rewinding dropped-span shape. In preserve mode this does not relax the requirement to cover all current tool traffic. Off by default because a rewind never reused a cache in measurements and costs a cold prefill. |
| `debug` | boolean | `false` | Log decisions to stderr. |
| `debugFile` | string | — | With `debug`, also append structured JSONL records (request fingerprints, request/response headers redacted, summary lifecycle) to this file. |
| `debugPayloads` | boolean | `false` | With `debug` + `debugFile`, dump the full request payloads around a compaction. **Contains the whole conversation** — keep the file private. |

## How it works

Pi still has its native emergency threshold at
`contextWindow - reserveTokens`, but preserve-dialogue mode no longer relies on
that fixed reserve for normal timing. At each `turn_end` boundary — after the
assistant message and all tool results for the turn have been persisted, and
before the next provider request — the extension measures the user messages and
visible assistant prose that survive every future compaction, subtracts that
permanent dialogue plus summary headroom from the model window, and compacts
when everything else occupies at least **90%** of the remaining usable budget.
This keeps long tool-using runs from overshooting the context before the agent
settles.

Normal preserve compaction is written directly as a Pi boundary compaction, so
the active agent run continues to its next turn; calling `ctx.compact()` at that
point would abort the run. Pi's native threshold and overflow recovery still
flow through `session_before_compact` as emergency fallbacks for a single turn
that grows past the safe boundary before `turn_end`.

*Forward* rather than *"a prefix of the live prompt"* is the part that took
measurement to get right. The obvious shape — send only the span Pi is about to
drop, which is a prefix of the live request — is a **rewind**, and an
append-only server cache (llama.cpp's per-slot KV checkpoint) answers a rewind
with a full re-prefill: a request 35 tokens shorter than the checkpoint
re-prefilled all 7710 tokens, while a continuation of it reused 7706/7745 in
0.4 s. Which messages the request carries is therefore chosen per compaction,
largest first, and only among shapes that fit the context window:

- `continuation` — the whole projection. Extends the checkpoint *including* the
  reply the server generated, so it is the safest cache bet and the required
  preserve-mode shape because it contains every current tool call/result.
- `continuation-request` — the messages of the last live request. This shorter
  forward continuation can be used only outside preserve mode; it may omit tool
  results that arrived after that request, so it cannot satisfy preserve mode's
  all-tool-state invariant.
- `dropped` — the rewind. Only used when the selected mode permits it. On
  append-only caches it has never reused the checkpoint and therefore costs a
  cold prefill.

Mirroring goes beyond the body: the ask replays the request headers the last
live request sent (minus transport-managed ones and `null` deletions), so
routing- or affinity-relevant headers match too, and it mirrors the reasoning
effort actually on the wire. Session-affinity headers (`x-session-affinity`,
added by pi-ai below the extension hooks when `compat.sendSessionAffinityHeaders`
is on) need no mirroring: both requests share the model and the session id, so
pi-ai derives them identically.

Every estimate in the fit check is **calibrated** against the server's own
reported prompt size (the same messages, so their ratio corrects the bytes-per-
token guess), and the reported part itself is exact. Without that, blob-heavy
transcripts came out ~3x high — enough to refuse a shape that would have fitted
and to make the reclaimed-size ceiling inert.

With `preserveDialogue: false`, summary scope still follows Pi's native
`firstKeptEntryId` / `keepRecentTokens` cut. Preserve mode is different:
**every tool call/result that exists when compaction runs belongs to the new
technical summary**, while every user message and visible assistant response is
restored verbatim. No pre-compaction tool tail remains raw merely because Pi's
native projection would have kept it.

The e2e test proves this from the recorded HTTP bodies: the summary request keeps
the conversation's system prompt, declares the same tools, and the previous live
request is a **strict prefix** of it — the entire live prompt is reusable from
cache, and only the ask is new.

### Preserve dialogue verbatim

By default, `preserveDialogue` is `true`, so a fresh install needs no extra config. Set it to `false` only to opt out. With preservation enabled, compaction has two separate responsibilities:

1. The cache-friendly continuation asks the model for a **technical checkpoint
   only**: tool calls/results, inspected repository/runtime state, edits,
   commands, tests, errors, validation, and unresolved technical findings.
   User messages and visible assistant prose are explicitly excluded from that
   summary.
2. A `context` hook rebuilds every later model request from Pi's append-only
raw session branch. All user messages and visible assistant text that existed
when the latest compaction ran are restored verbatim; every tool call/result and
all assistant reasoning from that same pre-compaction state stay removed. The
technical checkpoint is inserted after that preserved dialogue. Only messages
created **after** the compaction remain raw until the next compaction.

The compaction entry carries a versioned marker in `details`, so this behavior
survives Pi restarts and repeated compactions. Append-only `context_edit`
entries are honored when old dialogue is restored.

The proactive trigger uses the same preservation rule as restoration itself:
all user messages and visible assistant text are the permanent, non-compressible
part. At each tool-bearing `turn_end`, the remaining context budget is
recalculated with the exact summary-output headroom removed first; compaction
starts at **90%** occupancy of that remaining budget. Pi's fixed
`reserveTokens` threshold remains the emergency fallback if a single tool turn
overshoots before that boundary.

In interactive Pi, every preserve-mode compaction reports which path triggered
it (`normal (dynamic 90%)`, `emergency (Pi threshold)`, `overflow recovery`, or
`manual /compact`), the estimated token split between preserved and compactable
messages, and the full current context usage. After a successful compaction it
also displays the resulting tools/results technical checkpoint. These UI
notifications are diagnostic only and are never allowed to affect compaction.

This mode also fails closed: if a safe technical summary cannot be produced
(for example the cache is gone, the reply is unusable, or only a disallowed
rewind fits), the extension cancels that compaction instead of letting Pi
replace the preserved dialogue with its normal lossy summary.

This mode intentionally does **not** compress dialogue. If user prompts plus
assistant prose alone grow close to the model's context limit, no tool-output
compaction strategy can reclaim enough space; disable the mode or start a fresh
session at that point.

### Certification

Run `npm run certify` to execute typecheck, the full unit suite, and the real-Pi
end-to-end suite. The preserve-dialogue e2e test resumes one persisted session
across multiple Pi processes and repeated compactions, then verifies exact
user/assistant dialogue restoration, a single technical summary, strict
cache-prefix continuation, and removal of every tool call/result that existed
when each preserve compaction ran. Tool traffic created after the latest
compaction remains raw until the next one.

### What the summary contains

In the default mode, the ask is **Pi's own compaction prompt, copied verbatim** from
`core/compaction/compaction.js` (currently v0.87.0) — the structured checkpoint
with `## Goal`, `## Constraints & Preferences`, `## Progress`, `## Key
Decisions`, `## Next Steps`, `## Critical Context`. Pi does not export those
strings, so they are vendored; if Pi changes its format, copy the new text over.
The point is that the persisted summary is the artifact Pi would have written,
whichever path produced it:

- an existing summary switches the prompt to Pi's **update** variant (preserve
  what is there, merge the new);
- a **split turn** (the cut lands mid-turn) is asked for in Pi's two-part shape:
  the history summary, then `---`, then `**Turn Context (split turn):**` and the
  turn-prefix summary. Pi makes two calls for that; we ask for both parts in one
  reply, so the turn-prefix *format* is embedded without his prose — handed
  prose inline, the model copied it into the persisted summary;
- the summary is finished with Pi's machine-computed file appendix
  (`<read-files>` / `<modified-files>`), and the compaction result carries the
  same list in `details` — computed from the session, never by the model.

The two deliberate deviations are exactly the ones that make caching work: the
request reuses the conversation's system prompt and tools (Pi sends its own
summarization system prompt, which can never match), and it carries the real
messages instead of a serialization with tool results truncated to 2,000
characters.

## Caveats

- The first request after any compaction still prefills a new shared prefix. In
  the default mode that is `[system][summary][kept…]`; with
  `preserveDialogue` it is
  `[system][restored dialogue][tool summary][kept…]`. The extension removes
  the extra cold re-read used to *generate* the summary, not this unavoidable
  first request after the context shape changes.
- `preserveDialogue` makes user/assistant prose grow monotonically. When that
  preserved dialogue itself approaches the compaction threshold, repeated
  compaction cannot create useful headroom. Preserve mode cancels compaction
  rather than falling back to Pi's lossy summary, so a fresh session is the
  escape hatch once preserved dialogue itself is too large.
- In `preserveDialogue` mode, `keepRecentTokens` is **not** a preservation
policy. Pi still uses it internally while preparing its native compaction entry,
but the context hook does not replay that pre-compaction tail: old tool
calls/results are summarized regardless of the native cut, and old
user/assistant prose is restored independently. Do not tune
`keepRecentTokens` to retain tool history in preserve mode.
- `toolChoice: "none"` is ignored by some providers; if the model calls a tool
  anyway the reply is rejected and Pi's default summary runs.
- The fit estimates are calibrated against one reported prompt size, which
  assumes the conversation tokenizes uniformly. A blob-heavy tail can still be
  under-estimated; the server then rejects the request and Pi's (much smaller)
  default runs, which is why the calibration is bounded and the reported part of
  every estimate is used verbatim.
- Reasoning models occasionally end a turn *inside* their reasoning block, so the
  reply arrives with no text at all. Two defences: the ask prescribes an exact
  section format (the cheapest anchor there is, and it costs nothing — the ask
  is not part of the cached prefix), and an empty reply
  gets one retry that asks for the summary's first heading explicitly. Pi does
  **not** disable thinking for compaction either; it sends the session's level,
  exactly like this extension.
- The summary must reuse the exact system prompt and tool declarations. If
  another extension rewrites the request via `context`/`context_with_system`,
  the reconstructed prefix may no longer match (Pi's default will still be
  correct, just cold).
- The reasoning effort can be part of the *prompt*, not just the sampler: on a
  llama.cpp endpoint three variants (omitted, `low`, `medium`) produced three
  distinct cache keys, which is why the extension mirrors the effort the live
  request sent instead of picking one. That measurement went through a server
  running as a *router* with two model instances, so it may have measured the
  router rather than the template. The records settle it for your endpoint: set
  `summaryReasoningEffort` and read `cacheRead` on the next compaction — about
  the prompt size means the effort is free to change, `0` means it is not.
- Some servers serve a request from cache only when it *continues* the one
  before it, and re-prefill anything else — including a shorter request that is
  a prefix of it. One shared endpoint did exactly that: byte-identical repeats
  read ~96k of ~96k tokens in 0.8 s, while a rewind read 0 of the same 96k
  prefix **11 ms** after a live turn had read it. The extension handles it (the
  ask is a continuation, and a compaction where only a rewind would fit is left
  to Pi), but the `provider_request.rolling` / `provider_headers` /
  `provider_response` records are what tell you which of the two your server is
  doing.

## Debugging cache divergence

If compactions keep missing the prefix cache (`cacheRead: 0` on the summary
request despite the extension working), set:

```json
{ "debug": true, "debugFile": "/tmp/cache-compact-debug.jsonl" }
```

Every outgoing provider request — live turns (`before_provider_request` hook)
and the extension's own summarization call (pi-ai's `onPayload`, since our call
bypasses the extension runner) — is appended as a `provider_request` record
containing no payload content, only hashes:

- `rolling[]` — one entry per message: `rolling[i] = H(rolling[i-1] + H(message[i]))`.
  Equal prefixes of `rolling` ⟺ byte-identical message prefixes. Diff the arrays
  of the summary record against the preceding live record: the first differing
  index is where a prefix-caching server misses. Index 0 differing means the
  system prompt (or tools — see `toolsHash`) diverged.
- `summary: true` marks the extension's own request; `systemSource` says whether
  the system prompt came from the recorded transcript (`recorded`, the
  production path) or was rebuilt (`synthesized`); `requestShape` is
  `continuation` (whole projection), `continuation-request` (the last live
  request's messages — both forward, both cache-friendly) or `dropped` (a
  rewind, which re-prefills on an append-only cache), with
  `droppedCount`/`sentCount` giving what the summary covers versus what the
  request carried.
- `summary_start` / `summary_result` bracket each summarization with usage and
  timing; `summary_result.cacheRead` is the number you are hunting. A rejected
  attempt logs `stopReason`, `usage` and a per-block `blocks` summary
  (`[{type, chars}]`) — that is how a reply that stopped with **no text block**
  (the answer never left the reasoning channel) is told apart from a token-cap
  truncation, a tool call or a transport error.
- A continuation that read nothing from the cache is reported as *"previous
  continuation missed the cache; leaving compaction to Pi"*, and the next
  compaction steps aside (see `deferAfterCacheMiss`) — a cold whole-conversation
  prefill costs far more than Pi's little truncated prompt.
- `summary_retry` records the one retry that empty reply earns: the request is a
  cache hit, so it costs seconds. The retry appends its nudge after the ask, so
  everything the cache covers is unchanged.
- `provider_headers` — the request headers of a live turn (`summary: false`,
  from the `before_provider_headers` hook) and of the ask (`summary: true`,
  including what it replayed and whether a live request was observed at all).
- `provider_response` — response headers of live turns (`summary: false`,
  `after_provider_response`) and of the ask (`summary: true`, pi-ai's
  `onResponse`): replica/routing echoes and cache hints the body does not show.

  Header *values* of secret-looking names (`authorization`, `x-api-key`,
  `cookie`, …) are logged as `[redacted]`; the header *names* stay visible,
  because which headers differ is the diagnostic. If both live records show
  an empty bag, headers are provably not the reason a cache keeps missing.

For the *bytes* rather than the hashes, add `"debugPayloads": true`. The last
live request before a compaction (`live_before`), the summarization request, and
the first live request after it (`live_after`) are then dumped in full — only
around compactions, not per request. Diff the pair with the shipped script:

```bash
node scripts/compare-dumps.mjs /tmp/cache-compact-debug.jsonl
# messages: live_before=14, summarization=9, shared prefix=9
# RESULT: one request is a byte-identical prefix of the other (cache covers the first 9 messages).
```

It reports parameter diffs (usually just `max_tokens`), tool-declaration drift,
and the first differing message with a byte-level context snippet — enough to
tell an intentional cut (kept tail vs the ask) from real drift (same logical
message, different bytes). `debugPayloads` records contain the entire
conversation: never commit or share the dump file.

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # unit tests (node --test; Node 24+ runs TypeScript directly)
npm run test:e2e    # real `pi --print` + a mock model server (opt-in)
```

`npm run test:e2e` spawns Pi against a mock OpenAI-compatible server that records
request bodies, then asserts the summary request is a cache-hit continuation and
that Pi persisted it. It needs no network or credentials.

### Layout

```
src/
├── extension.ts   # the extension: session_before_compact handler
├── build.ts       # pure: summary ask, tool declarations, request assembly
├── config.ts      # pure-ish: option parsing and file loading
└── debug.ts       # pure: rolling hashes, payload fingerprints, JSONL logger
test/
├── build.test.ts       # pure helpers
├── config.test.ts      # option parsing/merging
├── extension.test.ts   # handler with a mock Pi context
└── e2e.test.ts         # real Pi + mock model server
scripts/
└── compare-dumps.mjs   # diff two recorded payloads from debugFile
```

## License

[MIT](LICENSE).

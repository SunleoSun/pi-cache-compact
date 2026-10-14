# AGENTS.md

Guidance for agents working in this repo. Read [`README.md`](README.md) and `sun-memory/project/index.md` first, then the relevant SunMemory architecture/workflow collection before changing owning behavior. Update stale SunMemory in the same transaction as any durable invariant change.

## Hard rules

**Never run `git commit` or `git push`** unless explicitly asked in that message. Preserve unrelated working-tree changes.

**Conventional Commits**, title line only, imperative, lower case, no trailing period: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `build:`, `ci:`, `perf:`.

**Semantic Versioning.** Published behavioral fixes bump patch, features minor, breaking changes major. Keep `package.json` and the root package version in `package-lock.json` aligned.

**No secrets, ever.**

## What this is

A Pi extension that makes compaction cache-friendly while preserving the human conversation. Preserve mode is reserve-driven: at every `turn_end`, if the projected context enters the final `reserveTokens` and older raw technical state exists before the current assistant message, it summarizes only that older state as a forward continuation, appends an immutable hidden checkpoint, keeps the current assistant/tool batch raw, and leaves the raw/TUI transcript untouched. This lets a batch carried by one checkpoint become eligible at the next turn even when that later turn has no tool results. Pi-native compaction is disabled and cancelled in preserve mode.

## Canonical owners

- `src/preserve.ts` — permanent-context semantics, append-only checkpoint lifecycle, delta boundary, restoration.
- `src/build.ts` — summary prompt, request planning, fit/token-budget helpers.
- `src/extension.ts` — Pi hooks, trigger policy, provider calls, UI and observability.
- `src/debug.ts` — cache fingerprints and bounded structured debug log.
- `src/config.ts` — configuration parsing/merging.

## Invariants — do not break these

| Thing | Why |
|---|---|
| Preserve mode permanently keeps every user message, every completed assistant reply (`stopReason: "stop"` with no tool call; visible text only), and every active historical Tool Context Checkpoint | Tool-use/interrupted assistant text, reasoning and tool traffic are compactable technical state. |
| Tool checkpoints are **append-only deltas** | A new checkpoint summarizes only raw tool/reasoning state after the latest active checkpoint. Never merge, rewrite, null, or supersede an older checkpoint. Legacy aggregated checkpoints become the immutable baseline. |
| Checkpoint summaries are result-oriented and grouped by absolute `User message N` | Preserve tool-derived findings/data, actual changes, validation evidence and unresolved state; do not replace results with a list of tool invocations and do not paraphrase the preserved user prompt. |
| Proactive preserve checkpointing must not append a Pi `compaction` entry | Pi clears/rebuilds TUI history on real compaction entries. Use context edits plus a `display:false` custom checkpoint so raw transcript history stays visible. |
| `reserveTokens` is the single preserve-mode trigger and summary-sizing policy | It is derived from the fitted context-window curve in `preserveReserveTokens()`. At every `turn_end`, Pi's current context already includes the completed turn; trigger when that current usage >= `contextWindow - reserveTokens` and older raw state exists before the current assistant message. Never add the current batch estimate twice. Preserve summary output may use up to that reserve, clipped only by the summarizer model and actual request fit. Refresh reserve on session start, model selection, and user input. Pi-native compaction is disabled/cancelled in preserve mode; no Pi settings file is rewritten. |
| Cache-friendly summary is the default request shape | Use the stable provider prefix plus the summary ask whenever it fits. Cache-sensitive request options mirror the last live payload by default, including an omitted tool-choice field. Preserve mode automatically uses a delta-only request when the cached shape cannot fit safely or when a cached summary itself stops at `length`; only that summary call loses prefix-cache reuse. |
| Historical checkpoints remain in the summary request only as immutable prefix context | They are never passed as `previousSummary` material to update. The summary scope is the new raw delta only. |
| Preserve-mode file appendices are checkpoint-local | Do not merge prior checkpoint file lists into a new delta checkpoint. Historical appendices remain in their immutable checkpoint. |
| Preserve token accounting is dialogue + historical checkpoints + new raw delta | Historical checkpoints are preserved tokens, not compactable state. Every token count shown in the compaction UI uses one provider-calibrated scale; context-after is the larger calibrated structural or reported-prefix-anchored estimate. Conservative bytes/3 estimates remain internal safety/audit state and must not be mixed into the displayed breakdown. |
| The current assistant/tool batch stays raw | A checkpoint absorbs only older raw technical state. The current assistant message plus its tool results remains atomically raw after the checkpoint and becomes eligible at the next `turn_end`, including a tool-free `length`/error/final turn. If the complete older delta is too large for a delta-only request with normal output reserve, compact the largest safe older prefix and carry the newest suffix forward raw; never split immediately before a tool result. The projected checkpoint message must retain its append timestamp, and restored historical assistant prose before it must expose zero prompt usage. |
| Delta-only summaries are preserve-mode safety paths | A delta-only request contains only a tiny summary instruction, the exact compactable technical delta and the checkpoint ask. Use it automatically when the cache-friendly request cannot fit, or once after any cache-friendly summary stops at `length`, independent of the live turn stop reason. Fit it from scratch; do not reuse embedded provider usage or calibration from the old full prefix. `rewindWhenNeeded`/`continuation: false` remain legacy/non-preserve request-shaping controls. |
| Manual `/compact` uses preserve mode | A real manual compaction bypasses the reserve threshold and checkpoints all currently uncheckpointed technical state through the same preserve summary path. Preserve mode also forces Pi's in-memory `keepRecentTokens` to 1 while native automatic compaction is disabled, so Pi's manual preparation reaches the extension hook even for short sessions. Pi persists the extension-provided compaction as an immutable preserve checkpoint without discarding earlier checkpoints; automatic Pi threshold/overflow compaction remains cancelled. |
| Bad summaries are never persisted | Summary provider calls first use Pi's effective `settings.retry` policy/classifier (`enabled`, retry budget and backoff) for transient provider errors. Provider retry delays are shown through Pi notifications. Parsed/textual tool-call replies and empty visible replies get one deterministic text-only retry; any cache-friendly summary that stops at `length` may retry once as delta-only. After those paths, reject truncated, aborted, tool-calling, or empty replies; preserve mode cancels rather than delegating to Pi's lossy summary. |
| Cache hit/miss metrics are diagnostics only | `cacheRead`, `cacheWrite`, and cold/warm outcomes never suppress, defer, or reshape a summary/checkpoint. |
| Provider/debug hooks never throw or mutate provider payloads accidentally | Observability must not affect compaction. Never write raw debug stderr while Pi owns an interactive TUI; use Pi notifications for user-visible status and JSONL for structured debug records. |
| `debugFile` is rolling JSONL capped at 1 MiB | Normal `debug: true` records structural message indexes only (role/kind/source/checkpoint/estimated tokens/hash), raw delta IDs, checkpoint hashes, token accounting and prefix divergence; it must not duplicate full provider conversations. `post_compaction_context` stores the actual next provider message index + tool names + shared-prefix counts. Full provider payload text is forensic-only via `debugPayloads: true` / `payload_dump`; `preserve_compaction.contextBefore/contextAfter` are also present only in that forensic mode. Never persist full provider tool declarations. Oldest complete records are evicted. |
| `src/build.ts` stays pure | Unit tests load it without booting Pi. Provider/message conversion remains in `extension.ts`. |

## Layout

```text
src/extension.ts
src/build.ts
src/preserve.ts
src/config.ts
src/debug.ts
scripts/compare-dumps.mjs
sun-memory/
project/index.md
architecture/
workflows/
test/
```

## Commands

```bash
npm install
npm run typecheck
npm test
npm run test:e2e
npm run certify
```

Node 24+; TypeScript runs directly.

## Verification

- `npm test` is the single complete test entrypoint: unit/integration tests, package metadata certification, and real-Pi E2E all run automatically.
- Real-Pi E2E covers forward cache continuation, three append-only checkpoints across restarts, actual post-compaction provider context, and raw/TUI transcript preservation.
- `npm run certify` is the release-grade local proof: typecheck + the complete `npm test` suite. `npm run test:e2e` is only a focused debugging alias.
- Run `git diff --check HEAD` and inspect Git/transaction diffs before finishing.

## Release

`npm publish` runs `prepublishOnly`. Publish only when explicitly requested. Stable Pi update command:

```bash
pi update npm:pi-cache-compact-preserved-messages
```

MCP transaction commit is not a Git commit.
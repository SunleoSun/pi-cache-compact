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
| The summary request is a forward continuation of the live conversation | Same stable system/tool/message prefix, then the summary ask, maximizes cache reuse. Preserve mode must not silently rewind by default. |
| Historical checkpoints remain in the summary request only as immutable prefix context | They are never passed as `previousSummary` material to update. The summary scope is the new raw delta only. |
| Preserve-mode file appendices are checkpoint-local | Do not merge prior checkpoint file lists into a new delta checkpoint. Historical appendices remain in their immutable checkpoint. |
| Preserve token accounting is dialogue + historical checkpoints + new raw delta | Historical checkpoints are preserved tokens, not compactable state. UI/debug must label provider-reported vs estimated counts honestly. Post-compaction estimation anchors to the last server-reported provider prefix when available, never discounts unseen UTF-8 bytes below the conservative bytes/3 baseline, and also keeps a structural full-request estimate. |
| The current assistant/tool batch stays raw | A checkpoint absorbs only older raw technical state. The current assistant message plus its tool results remains atomically raw after the checkpoint and becomes eligible at the next `turn_end`, including a tool-free `length`/error/final turn. The projected checkpoint message must retain its append timestamp, and restored historical assistant prose before it must expose zero prompt usage, so Pi cannot reuse a pre-checkpoint token count when sizing the first post-checkpoint response. |
| A rewind is normally opt-in (`rewindWhenNeeded`, `continuation: false`) | Rewinds lose append-only cache reuse. The one automatic exception is preserve recovery after a `length` turn when the already-sent provider prefix itself no longer fits: use a minimal cold request containing only a tiny recovery system/developer instruction, the exact technical delta and the checkpoint ask. Fit that cold request from scratch; do not reuse embedded provider usage or historical token-scale calibration from the old full prefix. |
| Manual `/compact` uses preserve mode | A real manual compaction bypasses the reserve threshold and checkpoints all currently uncheckpointed technical state through the same preserve summary path. Preserve mode also forces Pi's in-memory `keepRecentTokens` to 1 while native automatic compaction is disabled, so Pi's manual preparation reaches the extension hook even for short sessions. Pi persists the extension-provided compaction as an immutable preserve checkpoint without discarding earlier checkpoints; automatic Pi threshold/overflow compaction remains cancelled. |
| Bad summaries are never persisted | Summary provider calls first use Pi's effective `settings.retry` policy/classifier (`enabled`, retry budget and backoff) for transient provider errors. After that, reject truncated, aborted, tool-calling, or empty-after-retry replies; preserve mode cancels rather than delegating to Pi's lossy summary. |
| Cache hit/miss metrics are diagnostics only | `cacheRead`, `cacheWrite`, and cold/warm outcomes never suppress, defer, or reshape a summary/checkpoint. |
| Provider/debug hooks never throw or mutate provider payloads accidentally | Observability must not affect compaction. |
| `debugFile` is rolling JSONL capped at 1 MiB | `preserve_compaction` is a self-contained audit with predicted context before/after, per-message hashes/kinds/token estimates, raw delta entry IDs, checkpoint hashes, complete token accounting and divergence diagnostics; `post_compaction_context` records the actual next provider context/prefix. Never persist full provider tool declarations: log tool names plus compact declaration hashes only. Oldest complete records are evicted. |
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
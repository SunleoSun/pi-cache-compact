# AGENTS.md

Guidance for agents working in this repo. Read [`README.md`](README.md) and `sun-memory/project/index.md` first, then the relevant SunMemory architecture/workflow collection before changing owning behavior. Update stale SunMemory in the same transaction as any durable invariant change.

## Hard rules

**Never run `git commit` or `git push`** unless explicitly asked in that message. Preserve unrelated working-tree changes.

**Conventional Commits**, title line only, imperative, lower case, no trailing period: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `build:`, `ci:`, `perf:`.

**Semantic Versioning.** Published behavioral fixes bump patch, features minor, breaking changes major. Keep `package.json` and the root package version in `package-lock.json` aligned.

**No secrets, ever.**

## What this is

A Pi extension that makes compaction cache-friendly while preserving the human conversation. Preserve mode triggers at the earlier of its dynamic 90% pressure limit or Pi's effective native threshold, at a tool-bearing `turn_end`, summarizes only new tool-derived state as a forward continuation, removes that raw tool/reasoning state from model context through context edits, and appends a hidden tool checkpoint without clearing Pi's raw/TUI transcript.

## Canonical owners

- `src/preserve.ts` — permanent-context semantics, append-only checkpoint lifecycle, delta boundary, restoration.
- `src/build.ts` — summary prompt, request planning, fit/token-budget helpers.
- `src/extension.ts` — Pi hooks, trigger policy, provider calls, UI and observability.
- `src/debug.ts` — cache fingerprints and bounded structured debug log.
- `src/config.ts` — configuration parsing/merging.

## Invariants — do not break these

| Thing | Why |
|---|---|
| Preserve mode permanently keeps every user message, visible assistant text block, and every active historical Tool Context Checkpoint | These are the immutable cached conversation prefix. Old reasoning/tool traffic is not permanent. |
| Tool checkpoints are **append-only deltas** | A new checkpoint summarizes only raw tool/reasoning state after the latest active checkpoint. Never merge, rewrite, null, or supersede an older checkpoint. Legacy aggregated checkpoints become the immutable baseline. |
| Checkpoint summaries are result-oriented and grouped by absolute `User message N` | Preserve tool-derived findings/data, actual changes, validation evidence and unresolved state; do not replace results with a list of tool invocations and do not paraphrase the preserved user prompt. |
| Proactive preserve checkpointing must not append a Pi `compaction` entry | Pi clears/rebuilds TUI history on real compaction entries. Use context edits plus a `display:false` custom checkpoint so raw transcript history stays visible. |
| Preserve mode triggers only at tool-bearing `turn_end`, at the earlier of the 90% permanent-context budget or Pi's effective threshold | At that boundary all tool results are persisted and the next provider request has not started. Do not call `ctx.compact()` there because it aborts the active run. |
| The summary request is a forward continuation of the live conversation | Same stable system/tool/message prefix, then the summary ask, maximizes cache reuse. Preserve mode must not silently rewind by default. |
| Historical checkpoints remain in the summary request only as immutable prefix context | They are never passed as `previousSummary` material to update. The summary scope is the new raw delta only. |
| Preserve-mode file appendices are checkpoint-local | Do not merge prior checkpoint file lists into a new delta checkpoint. Historical appendices remain in their immutable checkpoint. |
| Preserve token accounting is dialogue + historical checkpoints + new raw delta | Historical checkpoints are preserved tokens, not compactable state. UI/debug must label provider-reported vs estimated counts honestly. |
| Preserve mode compacts all new tool traffic in the delta | Tool calls/results/reasoning created after the latest checkpoint must be absorbed before success. If the valid full-delta request cannot be made, fail closed. |
| A rewind is opt-in (`rewindWhenNeeded`, `continuation: false`) | Rewinds lose append-only cache reuse. Preserve mode cancels rather than silently taking a lossy fallback. |
| Bad summaries are never persisted | Reject truncated, aborted, tool-calling, or empty-after-retry replies. Preserve mode cancels rather than delegating to Pi's lossy summary. |
| Cache hit/miss metrics are diagnostics only | `cacheRead`, `cacheWrite`, and cold/warm outcomes never suppress, defer, or reshape a summary/checkpoint. |
| Provider/debug hooks never throw or mutate provider payloads accidentally | Observability must not affect compaction. |
| `debugFile` is rolling JSONL capped at 1 MiB | `preserve_compaction` is a self-contained audit with predicted context before/after, per-message hashes/kinds/token estimates, raw delta entry IDs, checkpoint hashes, complete token accounting and divergence diagnostics; `post_compaction_context` records the actual next provider context/prefix. Oldest complete records are evicted. |
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
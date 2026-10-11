# AGENTS.md

Guidance for agents working in this repo. Read [`README.md`](README.md) first for
what the extension is and how it is installed.

## Hard rules

**Never run `git commit` or `git push`** unless explicitly asked in that message.
Write files, stage nothing, report what changed, and let the human commit.

**Conventional Commits**, title line only, imperative, lower case, no trailing
period: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `build:`,
`ci:`, `perf:`.

**Semantic Versioning.** Bump `version` in `package.json` in the same commit:
`feat` → minor, `fix` → patch, breaking → major. `docs`/`test`/`chore` do not
need a bump unless they change published behaviour.

**No secrets, ever** — nothing here needs one.

## What this is

A Pi extension that replaces Pi's compaction *summary generation* with a
cache-friendly one:

> preserve mode reaches 90% of the budget left after permanent dialogue ->
> `turn_end` (all tool results persisted, next provider request not started) ->
> we send the summarization ask as a continuation of the live conversation ->
> append a preserve compaction boundary and let the agent continue. Pi's native
> threshold/overflow path remains the emergency fallback through `session_before_compact`.

It exists for two reasons, both in README → "Why": Pi's default summary is a
cold, brand-new prompt (no cache reuse possible), and it truncates every tool
result to 2,000 characters before summarizing, which for a coding session is
most of the substance.

## Invariants — do not break these

| Thing | Why |
|---|---|
| `src/extension.ts` default-exports the factory and nothing else at runtime | Pi calls the default export; extra runtime exports are noise. Type-only exports are fine. |
| Preserve mode triggers dynamically at 90% of the budget left after permanent dialogue, only at tool-bearing `turn_end` boundaries | Count every user message and visible assistant text block with the same semantic owner used by restoration, subtract that plus summary headroom from the context window, and compact when the rest reaches 90%. The boundary is after the turn's tool results are persisted and before the next provider request; do not use `ctx.compact()` there because it aborts the active run. Pi's fixed reserveTokens threshold is only the emergency fallback for a single turn that overshoots before the boundary. |
| Preserve-mode UI diagnostics are observational only | In interactive Pi, report the trigger branch, preserved/compactable message-token estimates, full context usage, and the resulting tools/results checkpoint. Notification failure must never affect compaction. |
| The summary request must reuse the conversation's exact prefix | Same system prompt, same tools, same messages, then the ask. Anything else and the cache misses — the whole point is lost. |
| The ask is a **forward continuation**, never a rewind to the dropped span by default | An append-only server cache reuses only if the new prompt extends what it holds. Preserve mode requires the whole live continuation because every current tool result must be represented; the shorter last-request continuation is valid only outside preserve mode because it can omit fresh tool results. |
| The summary ceiling is derived, not a constant: Pi's `0.8 × reserveTokens` clamped to the model, bounded by half of what the compaction drops, floored at 2048 | A ceiling is not a target, so a generous one costs nothing and avoids the expensive failure (a cap-truncated reply is rejected and Pi's default runs). Pi's reserve alone is not the invariant it looks like — split turns apply it twice and can exceed it — so it is bounded by what the compaction actually reclaims. `summaryMaxTokens` overrides. |
| A rewind is a deliberate opt-in (`rewindWhenNeeded`, `continuation: false`), never a silent fallback | A rewind never reused a cache in any measurement and costs a cold prefill. Where only the rewind fits, normal mode may leave compaction to Pi; preserve mode cancels because Pi's lossy fallback would violate verbatim dialogue. |
| Fit estimates are calibrated against the server's reported prompt size | `bytes / 3` alone is ~3x high on blob-heavy transcripts: it refuses shapes that fit and makes the reclaimed-size ceiling inert. `tokenScale` derives one ratio per decision from a reported prompt and the same messages. |
| A large summary cache miss defers another full-prefix attempt for 15 minutes | `usage.cacheRead === 0` with a large prompt means the checkpoint is gone. Normal mode may use Pi's small fallback; preserve mode must cancel instead of losing verbatim dialogue. `deferAfterCacheMiss: false` opts out. |
| With `preserveDialogue: false`, the ask is Pi's compaction prompt; the default preserve mode uses a tool-only checkpoint | Pi's default prompts remain vendored in `build.ts`. Preserve-dialogue mode must never paraphrase user messages or visible assistant prose: raw dialogue is restored through the `context` hook, while the summary owns only compacted tool-derived state; old reasoning is discarded. Both modes keep the machine-computed `<read-files>`/`<modified-files>` appendix and versioned `details`. |
| Preserve mode compacts **all** tool traffic present at compaction time | Pi's native `firstKeptEntryId` / `keepRecentTokens` cut is not the semantic owner in preserve mode. The tool checkpoint covers all current tool calls/results; the context hook restores all pre-compaction user messages + visible assistant text, drops all pre-compaction tools/reasoning (including Pi's nominal kept tail), then keeps only messages created after the compaction raw. Normal `preserveDialogue: false` mode still follows Pi's native cut. |
| Do not pass `systemPrompt`/`tools` when the projection already has a leading system message | The provider would replay/concatenate the prompt twice and the prefix would break. See `hasLeadingSystemMessage` in `extension.ts`. |
| Never accept a truncated, aborted, tool-calling, or empty summary **after one retry** | A bad summary must never become the new conversation prefix. Normal mode returns `undefined` so Pi's default runs; `preserveDialogue` returns `{ cancel: true }` so verbatim dialogue cannot be lost. The one retry is for a reply that stopped with no text block; other failures repeat deterministically. |
| Never throw out of the handler | In normal mode Pi's fallback remains valid. In `preserveDialogue` mode a fallback would violate the verbatim-dialogue invariant, so cancel that compaction instead of silently delegating to Pi's lossy summary. |
| Debug `onPayload` hook returns `undefined` and never throws | A returned value would replace the outgoing request payload; a throw would kill the summarization call. Fingerprint only. |
| `src/build.ts` stays pure (type-only SDK imports) | Unit tests exercise it without booting Pi. Message conversion (`convertToLlm`) happens in `extension.ts`; `planSummaryRequest` takes already-converted messages. |
| The request shape and the ask are decided once, by `planSummaryRequest` | The handler hashes the ask to tag in-flight requests, and the fallback tag must match the ask that is actually sent. Two places computing the ask drifted apart once already. |

## Layout

```
src/extension.ts   # default export; session_before_compact handler
src/build.ts       # pure helpers: prompt, tool declarations, request assembly
src/config.ts      # option parsing + merging JSON files
src/debug.ts       # rolling hashes + payload fingerprints + JSONL debug logger
scripts/compare-dumps.mjs  # diff payload_dump records from debugFile
test/              # build, config, debug, extension (mock ctx), e2e (real Pi + mock model)
```

## Commands

```bash
npm install
npm run typecheck # tsc --noEmit
npm test # unit tests (node --test)
npm run test:e2e # real `pi --print` + mock model server (opt-in)
npm run certify # typecheck + unit suite + real-Pi e2e certification
```

Node 24+ — the repo runs TypeScript directly and uses `node --test`.

## Verifying

- **Unit** (`npm test`) covers the pure assembly, option parsing, and the
  handler's fallbacks with a mock context. Any change to the request shape, the
  fallback rules, or the options needs a matching test.
- **End-to-end** (`npm run test:e2e`) is the one that catches real Pi behaviour:
it spawns `pi --print` with the extension loaded from source and a mock
OpenAI-compatible server that records HTTP bodies. Besides the cache-prefix
contract, the preserve-dialogue certification runs multiple real Pi processes
against one resumed session and proves repeated compaction restores old user
prompts and visible assistant prose verbatim while compacted tool traffic stays
out. Run it after touching the entry point, hooks, restore logic, or request
assembly.
- **Certification** (`npm run certify`) is the release-grade local proof:
typecheck + the complete unit suite + the real-Pi e2e suite. It needs no
network and no credentials.

## Releasing

`npm publish` runs `prepublishOnly` (typecheck + unit tests). Bump `version` in
`package.json` in the release commit, with a matching `feat:`/`fix:` message.
The published package loads `src/extension.ts` directly (`pi.extensions`), so
there is no build step to forget — but that also means the shipped code is the
TypeScript source, and `files` must keep `src/` and `scripts/`.

## Conventions

- Prefer explaining *why* in comments — especially the prefix-reuse invariant.
- Keep the README caveats honest: if a workaround is removed, explain the cost
  in the same change.
- Config lives in `cache-compact.json` under the agent dir and `<cwd>/.pi`;
  document any new option in the README table.

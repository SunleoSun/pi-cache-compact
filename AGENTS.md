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

> threshold crossed → Pi fires `session_before_compact` → we send the
> summarization ask as a continuation of the live conversation (same system
> prompt, same tools, same messages) → Pi persists the returned summary and
> keeps its own cut/trigger.

It exists for two reasons, both in README → "Why": Pi's default summary is a
cold, brand-new prompt (no cache reuse possible), and it truncates every tool
result to 2,000 characters before summarizing, which for a coding session is
most of the substance.

## Invariants — do not break these

| Thing | Why |
|---|---|
| `src/extension.ts` default-exports the factory and nothing else at runtime | Pi calls the default export; extra runtime exports are noise. Type-only exports are fine. |
| The summary request must reuse the conversation's exact prefix | Same system prompt, same tools, same messages, then the ask. Anything else and the cache misses — the whole point is lost. |
| The ask is a **forward continuation**, never a rewind to the dropped span | An append-only server cache (llama.cpp's per-slot KV checkpoint) reuses only if the new prompt extends what it holds; a shorter request re-prefills from scratch. Measured: 35 tokens shorter → 7710 re-prefilled; a continuation → 7706/7745 reused in 0.4 s. Three shapes, largest first: the whole projection, the last live request's messages, then the dropped span (last resort / `continuation: false`). The last-request shape is not optional decoration — Pi can compact because a huge tool result arrived, and that result alone can push the projection past the window. |
| The summary ceiling is derived, not a constant: Pi's `0.8 × reserveTokens` clamped to the model, bounded by half of what the compaction drops, floored at 2048 | A ceiling is not a target, so a generous one costs nothing and avoids the expensive failure (a cap-truncated reply is rejected and Pi's default runs). Pi's reserve alone is not the invariant it looks like — split turns apply it twice and can exceed it — so it is bounded by what the compaction actually reclaims. `summaryMaxTokens` overrides. |
| A rewind is a deliberate opt-in (`rewindWhenNeeded`, `continuation: false`), never a silent fallback | A rewind never reused a cache in any measurement and costs the whole conversation as a cold prefill — worse than Pi's own small summary. Where only the rewind fits, leave the compaction to Pi (logged as "only the rewinding shape fits"). |
| Fit estimates are calibrated against the server's reported prompt size | `bytes / 3` alone is ~3x high on blob-heavy transcripts: it refuses shapes that fit and makes the reclaimed-size ceiling inert. `tokenScale` derives one ratio per decision from a reported prompt and the same messages. |
| A summary whose response read nothing from the cache disables the continuation for 15 minutes | `usage.cacheRead === 0` with a large prompt means the checkpoint is gone, and then the whole-conversation request is the expensive shape — Pi's small truncated prompt prefills in seconds. `deferAfterCacheMiss: false` opts out. |
| With `preserveDialogue: false`, the ask is Pi's compaction prompt; the default preserve mode uses a tool-only checkpoint | Pi's default prompts remain vendored in `build.ts`. Preserve-dialogue mode must never paraphrase user messages or visible assistant prose: raw dialogue is restored through the `context` hook, while the summary owns only compacted tool-derived state; old reasoning is discarded. Both modes keep the machine-computed `<read-files>`/`<modified-files>` appendix and versioned `details`. |
| The summary *text* covers only the messages before `firstKeptEntryId` | Pi keeps `keepRecentTokens` verbatim, so a summary that also covers the tail describes it twice and grows the context. With the continuation shape the scope is enforced by the boundary note in the ask (`SummaryBoundary`), not by the message list. In `preserveDialogue` mode the summary is additionally restricted to tool-derived state; dialogue comes from the append-only raw branch. |
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

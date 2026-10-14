# pi-cache-compact-preserved-messages

Cache-friendly compaction for Pi that keeps the human conversation verbatim and replaces old tool traffic with small, append-only technical checkpoints.

## Why

Long coding sessions accumulate large tool results and assistant reasoning. Pi's normal compaction builds a fresh summary prompt, which can forfeit a provider's prefix cache, and its summary does not preserve the user's original wording. This extension keeps the stable conversation prefix and summarizes only technical tool-derived state.

## Install and update

```bash
pi install npm:pi-cache-compact-preserved-messages
```

After a published update:

```bash
pi update npm:pi-cache-compact-preserved-messages
```

List managed packages with `pi list`.

## Preserve mode

`preserveDialogue` defaults to `true`. The permanent model context consists of:

- every historical **user message**, verbatim;
- every completed **assistant response** (`stopReason: "stop"` and no tool call), preserving its visible text verbatim;
- every historical **Tool Context Checkpoint**, immutable after creation.

Assistant reasoning, assistant text from tool-use/interrupted/error/length responses, tool calls and tool results are compactable technical state.

Preserve mode checks at every `turn_end`. `reserveTokens` is the only preserve-mode threshold policy and is derived from the smooth fitted curve `round(88319.65 + (1468.926 - 88319.65) / (1 + (contextWindow / 1413076)^0.7096055))`. Because `turn_end` runs after the current turn is in Pi's projection, a checkpoint starts when Pi's current context usage reaches `contextWindow - reserveTokens` and older raw technical state exists before the current assistant message; the current-batch estimate is used for raw-tail accounting, not added to the already-current context a second time. The current assistant/tool batch is deliberately excluded from the summary and remains raw after the new checkpoint; it becomes eligible at the following turn boundary even if that later turn has no tool results. Summary output may use up to `reserveTokens`, clipped by the summarizer model and the request's actual remaining fit. Pi-native automatic threshold/overflow compaction is disabled/cancelled in preserve mode; manual `/compact` is routed through the preserve compactor. The reserve is refreshed at session start, model selection, and user input, with a model-aware fallback if needed.

### Append-only checkpoints

Checkpoints are deltas, not rewritten cumulative summaries.

```text
User message 1
Assistant visible text
Tool Context Checkpoint #1
User message 2
Assistant visible text
Tool Context Checkpoint #2
...
```

When checkpoint #2 is created, checkpoint #1 remains byte-identical in the model context. The new summary covers only tool activity created after checkpoint #1. This keeps the longest possible previously cached prefix stable.

Legacy sessions created by older versions are migrated conservatively: the latest active old aggregated preserve checkpoint becomes the immutable baseline; checkpoints that were already nulled by old context edits stay ignored.

## What a tool checkpoint contains

The preserve prompt is deliberately **result-oriented**. It does not use a global list such as “read file X / ran tool Y”. Tool-derived information is grouped by the absolute user-message ordinal that caused the work:

```text
## Tool Context
### User message 5
#### Findings
- `src/foo.ts` routes retries through `RetryPolicy.nextDelay`; no second retry loop was found.

#### Changes & Validation
- `cargo test -p targets`: 214 passed, 5 ignored, 0 failed.

#### Unresolved
- (none)
```

The original user prompt is already present verbatim, so the checkpoint identifies it only as `User message N` and does not paraphrase it. The extension also injects the exact absolute user-message ordinals covered by the new delta into the summary ask; this prevents a delta-only summary request from renumbering a user turn merely because earlier dialogue is outside that request. A tool loop may continue across checkpoint boundaries; new tool evidence remains associated with the user message that initiated that work.

Historical checkpoints are immutable prefix context. A later summarization request must not repeat, merge, update or supersede them.

## Cache behavior

The summary request is normally a strict forward continuation of the live conversation: same system prompt, same tool declarations and same cached message prefix, then one extra user ask. Cache-sensitive request options mirror the last live payload by default, including whether tool choice was omitted. Preserve mode automatically switches to a **delta-only summary** when that cached request cannot fit safely; only the technical state being compacted is sent for that one summary call. `continuation: false` and `rewindWhenNeeded: true` remain legacy/non-preserve request-shaping controls.

After compaction, divergence should start only where newly compacted raw tool/reasoning state disappeared. User/assistant dialogue and older checkpoints stay stable.

When the current batch crosses the reserve boundary, the summary request continues from the previous provider prefix, before that batch. The current batch stays raw after the new checkpoint and becomes eligible at the next `turn_end`. If the cache-friendly summary request cannot fit, preserve mode automatically sends a **delta-only summary request**: a tiny summary instruction plus only the exact technical delta being compacted. If a cache-friendly summary request fits but its generated summary itself stops at `length`, the same delta is retried once in delta-only form regardless of how the live assistant turn ended. If the complete delta-only request is still too large to leave the normal summary-output reserve, the extension compacts the largest safe older prefix and carries the newest unsummarized suffix forward as raw state after the checkpoint; that suffix is eligible for a later checkpoint. Boundaries are chosen before user/assistant messages, never before a tool result, so an assistant tool-call batch stays with its following results. Delta-only fit is estimated from scratch with the conservative UTF-8 bytes/3 baseline: stale provider calibration and embedded `usage` from the old full prefix are ignored. A single indivisible technical unit that itself cannot fit still fails closed rather than being silently dropped. Parsed/textual tool-call summaries and empty visible summaries get one deterministic text-only retry. The checkpoint's projected model message retains its append timestamp so Pi's estimator cannot reuse stale pre-checkpoint usage. If no older compactable state exists, preserve mode does not manufacture a checkpoint.

### Recovery certification

The test suite includes real-Pi/provider-level recovery certifications, not only mocked extension handlers. The direct-overflow case creates one normal preserve checkpoint, carries a large second tool batch raw, makes the next provider request report a 56,172-token prompt against a 50,000-token window and stop with `length`, then exercises the delta-only summary path. The certification verifies that the request contains the exact tool call ID/name/arguments and the complete 40,000-character tool result, uses the correct absolute owning user ordinal, and excludes preserved dialogue, earlier tool state/checkpoints, and the current truncated assistant tail.

A second certification covers the production edge case where the cache-friendly summary request still fits, but the summary itself ends at `length`. Pi first attempts the cached checkpoint, the mock truncates that summary, then the extension retries the same exact technical delta with a delta-only request. The test verifies that the retry excludes checkpoint/preserved-prefix state, checkpoint #2 is persisted, the large raw result disappears from model-visible context, and a later ordinary Pi request continues successfully from checkpoints #1 + #2.

After recovery, the certifications inspect actual provider payloads. They verify that preserved user dialogue and immutable checkpoints survive, the provider-message prefix before compacted raw state remains stable where applicable, compacted tool call/results are gone from model-visible context, the current `length` assistant tail remains raw, output headroom is usable, and the model successfully produces a normal `done` response. Raw JSONL remains append-only and retains the original tool traffic.

## Compaction UI

Every successful preserve compaction persists a typed `cache-compact-report-v1` session entry that is UI-only and never enters model context. Persistent reports always render their full body; they do not collapse with Pi's global expanded-output flag.

Automatic compaction uses a standalone report: full token accounting plus the new checkpoint summary.

```text
[cache-compact]

44,807 → ~15,693 tok
compacted: ~29,319 tok
raw tail kept: ~8,754 tok
compression: 178.8x

checkpoints total: ~164 tok
 checkpoint #1: ~164 tok (new)

compacted content:
 tool calls: ~1,341 tok
 tool results: ~24,633 tok
 reasoning: ~3,345 tok

base context:
 system prompt: ~5,655 tok
 tool declarations: ~1,093 tok

covered user messages: 1

tools/results summary:

## Tool Context
### User message 1
...
```

Manual `/compact` keeps Pi's native `[compaction]` card as the summary owner and persists a supplemental cache-compact report containing statistics only. This avoids displaying the summary twice while still keeping the complete accounting visible after TUI rebuild/reload.

`context before` is Pi's current context usage at the boundary; it can include locally estimated newly appended tail state, so it is not always an exact provider token count. `context after` and every token count in the displayed breakdown use the same provider-calibrated scale. `raw tail kept` is the calibrated technical state deliberately retained after the checkpoint and is shown directly after `compacted`. The UI takes the larger of its calibrated structural and reported-prefix-anchored after estimates; conservative UTF-8 bytes/3 accounting remains internal for fit/safety decisions and structured debug audits.

## Configuration

Configuration is merged from:

1. `<agent-dir>/cache-compact.json`
2. `<cwd>/.pi/cache-compact.json` (project values win)

Example:

```json
{
  "preserveDialogue": true,
  "continuation": true,
  "debug": true,
  "debugFile": "/tmp/cache-compact-debug.jsonl"
}
```

| Option | Meaning |
|---|---|
| `enabled` | Disable the extension with `false`. |
| `models` | Optional `provider/modelId` allowlist. |
| `summaryModel` | Optional `{ provider, id }` summarizer; falls back to active model. |
| `summaryPrompt` | Replace the default summary instruction. |
| `preserveDialogue` | Preserve dialogue + append-only technical checkpoints. Default `true`. |
| `summaryReasoningEffort` | Explicit summary effort. Omitted mirrors the last live request. |
| `cacheRetention` | Provider cache retention: `none`, `short`, `long`; default `short`. |
| `toolChoice` | Optional `none`/`auto` override. By default cache-friendly summaries mirror the last live request, including an omitted tool-choice field; delta-only/text-only retries use `none`. |
| `continuation` | Prefer a forward continuation of the cached conversation. Default `true`. |
| `rewindWhenNeeded` | Legacy/non-preserve control that permits a dropped-span request when no continuation fits. Preserve mode automatically uses delta-only summaries when needed. |
| `debug` | Master debug switch. `false` (default) disables stderr/structured debug output and never creates/touches `debugFile`. |
| `debugFile` | Absolute JSONL path for structured diagnostics. The file is written only when `debug: true`. |
| `debugPayloads` | Optional compact payload dumps around compaction for `compare-dumps.mjs`; conversation messages are retained, but provider tool declarations are stored as names only. |

Summary provider failures use Pi's effective `settings.retry` policy before compaction is rejected. Cache-compact uses the same transient-error classifier and the same `retry.enabled`, `retry.maxRetries`, `retry.baseDelayMs`, and `retry.maxAgentDelayMs` values as Pi's own compaction/branch-summary path; there is no separate retry configuration. In an interactive Pi UI, scheduled provider retries show the attempt number and wait time, and deterministic summary retries / delta-only transitions are also announced so a long compaction does not look stuck.

`/compact` also uses the preserve-dialogue compactor when preserve mode is enabled. Manual compaction does not wait for the reserve threshold: it checkpoints all currently uncheckpointed technical state while preserving user messages and completed assistant answers. The returned native compaction keeps `firstKeptEntryId` at the earliest transcript message, so Pi may rebuild its TUI after the manual compaction without hiding the earlier transcript; provider context is still rebuilt by the extension from preserved dialogue/checkpoints rather than replaying compacted tool traffic. Pi's saved manual-compaction system snapshot is never re-injected into that rebuilt conversation, avoiding a duplicate system prompt. While preserve mode is active the extension keeps Pi's automatic compaction disabled and sets Pi's in-memory `keepRecentTokens` to 1, solely so manual preparation cannot reject a short session before the extension hook runs.

## Debugging and observability

`debugFile` is written only when `debug: true` and a path is configured; `debug: false` never creates or touches it. It is a **rolling JSONL file with a hard 1 MiB limit**. Before appending a record that would exceed the limit, the logger evicts the oldest complete JSONL records. If one record alone is larger than 1 MiB, it is replaced by a small `log_record_oversize` marker. The logger never throws into the compaction path. In interactive Pi TUI sessions debug diagnostics are not written directly to stderr, because asynchronous stderr output corrupts the composer area. Successful compactions are persisted as `cache-compact-report-v1` UI entries; Pi notifications are reserved for transient retry/warning/failure status, while structured diagnostics stay in JSONL. The extension itself performs no other runtime filesystem writes; Pi still persists its own normal session/transcript files.

Provider usage/cache metrics are observability only. Live input/output/reasoning counts, cache read/write counts, and stop reason are added to the existing `dynamic_compaction_pressure` record, so this costs only a few scalar fields per turn instead of another record. They never reshape compaction behavior.

The canonical records are:

- `preserve_compaction` — one self-contained structural audit record per successful preserve checkpoint. It contains checkpoint number/scope, absolute covered user-message ordinals, raw branch entry IDs/boundaries, historical checkpoint IDs/hashes, provider tool names, a per-message index (`role`, semantic kind, source session-entry ID, checkpoint number, estimated tokens, hash), complete token accounting, compression/compacted estimates, and stable-prefix divergence diagnostics. With ordinary `debug: true`, full `contextBefore`/`contextAfter` message bodies are omitted; they are included only in forensic `debugPayloads: true` mode.
- `post_compaction_context` — the **actual next provider** structural message index and tool names after the checkpoint, plus exact provider-message shared-prefix counts against the previous live request and hashes of checkpoints present in the branch. Provider payload normalization understands both message-array requests and Codex/Responses `instructions + input`, so the message index is populated for either shape. It deliberately does not duplicate conversation text. If a `length` stop ends that process and the session is resumed later, the pending in-memory marker cannot cross the restart; the recovery E2E therefore certifies the resumed provider payload directly.
- `provider_request`, `provider_headers`, `provider_response` — request/cache fingerprints and redacted transport diagnostics.
- `summary_start`, `summary_result`, `summary_retry` — summary lifecycle and the deterministic retry for unusable non-error summary output.
- `summary_provider_retry_scheduled`, `summary_provider_retry_attempt_start`, `summary_provider_retry_finished` — transient provider retry lifecycle driven by Pi's `settings.retry`.

Normal debug records can still contain checkpoint summaries and tool-derived metadata, so treat them as private, but they no longer duplicate the full provider conversation. This keeps the 1 MiB rolling log useful for more historical events and makes shared diagnostic logs much smaller.

`debugPayloads: true` is the explicit forensic mode for full message payloads. It emits `payload_dump` records (`live_before`, `summarization`, `live_after`) for `scripts/compare-dumps.mjs`; provider tool schemas are replaced by tool names before anything is written. In that mode `preserve_compaction` also includes full predicted `contextBefore`/`contextAfter`. `provider_request` keeps the tool count, names, and a short hash of the full declaration set, so schema changes remain detectable without bloating ordinary logs.

## Token accounting

Preserve-mode accounting separates:

- provider-reported context before;
- estimated non-system context before, system prompt, tool declarations, and residual provider overhead;
- preserved dialogue, with separate user-message and visible-assistant-text estimates;
- historical checkpoint tokens + count;
- total raw technical state before checkpointing, including tool calls/results/reasoning/other;
- the older raw portion actually compacted and the newest raw tail intentionally kept;
- new checkpoint size, remaining raw technical state, estimated context after, compacted raw tokens and compression.

Historical checkpoints are preserved tokens; they are never counted as raw state to compact again.

## Development

```bash
npm install
npm run typecheck
npm test
npm run test:e2e
npm run certify
```

`npm test` is the single complete test entrypoint: unit/integration checks, source/package metadata certification, and real-Pi E2E all run automatically. `npm run test:e2e` is only a focused E2E alias. `npm run certify` adds TypeScript typecheck before that complete suite.

The real-Pi preserve certification exercises three append-only compactions across restarts, verifies the logged post-compaction context against the actual provider payload, and checks that user/assistant dialogue and old checkpoints survive while compacted raw tool traffic stays out of later model context.

## Project memory

Durable architecture/workflow knowledge lives under `sun-memory/`. Start with `sun-memory/project/index.md`. The source remains canonical; SunMemory records the invariants and discovery paths agents should reuse.

## Package layout

Pi loads `src/extension.ts` directly; there is no build artifact. Published files include `src/`, `scripts/`, `README.md`, and `LICENSE`.
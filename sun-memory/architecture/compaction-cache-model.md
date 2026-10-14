---
description: Append-only checkpoint cache-prefix invariants, token accounting, and observability.
---
# Compaction cache model

## Canonical invariant

After a preserve compaction the provider-visible history is:

```text
immutable user/completed-assistant dialogue
+ immutable historical Tool Context Checkpoints
+ NEW delta Tool Context Checkpoint
+ later live state
```

The old prefix must remain unchanged. A later checkpoint summarizes only tool activity after the previous checkpoint.

## Cache behavior

Summary requests are forward continuations of the live conversation whenever they fit. Cache-key request options mirror the last live provider payload by default: reasoning effort and tool choice preserve explicit values or omission, and replayable headers are copied. Historical checkpoints remain in the request only as immutable prefix context; they are not material to resummarize.

After compaction, cache divergence should begin only where newly compacted raw tool/reasoning state was removed. Earlier dialogue and checkpoints must remain stable.

Cache hit/miss outcomes are observability only. Every checkpoint is planned from the current live context as a forward continuation; `cacheRead: 0` never suppresses a later checkpoint, changes summary scope, or delegates compaction semantics to Pi. Transient provider errors during summary generation are retried independently using Pi's effective `settings.retry` policy; cache metrics never influence that retry decision.

Preserve mode owns a single `reserveTokens` policy instead of inheriting Pi's fixed reserve or layering extra 90%/2048-token margins. `preserveReserveTokens(contextWindow)` uses the fitted curve `round(88319.65 + (1468.926 - 88319.65) / (1 + (contextWindow / 1413076)^0.7096055))`. Every `turn_end` runs after the completed turn is represented in Pi's current context usage, so trigger directly when that usage reaches `contextWindow - reserveTokens` and older raw state exists before the current assistant message; the locally estimated current-batch size is for raw-tail accounting and must not be added to current usage again. This includes tool-free `length`/error/final turns, allowing a raw batch carried by the previous checkpoint to become eligible without requiring another tool call. The reserve is refreshed on session start, model selection and user input, with a model-aware fallback if the model/window changes unexpectedly.

The triggering assistant/tool batch is normally the raw tail: summarize older raw technical state, append the new immutable checkpoint, then keep the current batch raw after it. Normal preserve summaries are forward continuations for cache reuse. If the cache-friendly request cannot fit, preserve mode automatically switches to a **delta-only summary** containing only a tiny summary instruction, the exact technical delta, and the checkpoint ask. If a cache-friendly summary itself ends at `length`, retry the same exact delta once as delta-only regardless of the live turn's stop reason. Delta-only fit ignores provider `usage` and token-scale calibration from the old full prefix and is estimated from scratch with the conservative UTF-8 bytes/3 baseline. If the full delta-only request cannot retain the normal summary-output reserve, select the largest safe older prefix that can, checkpoint it, and carry the newest suffix raw after the checkpoint; safe boundaries are before user/assistant messages and never before a tool result. Thus multiple accumulated batches cannot deadlock merely because their combined delta approaches the whole window. A single indivisible technical unit larger than the usable delta-only window still fails closed. The checkpoint's model-visible message must carry the checkpoint entry's append timestamp (or a synthetic timestamp newer than the branch for previews), and restored historical assistant prose before that checkpoint must expose zero prompt usage. Summary output may use up to `reserveTokens`, clipped only by the summarizer model and actual request fit. Pi-native automatic compaction remains disabled. Manual `/compact` routes through the same preserve semantics, persists an append-only preserve-marked native checkpoint, returns the earliest transcript message as Pi's `firstKeptEntryId` so the TUI rebuild keeps prior history, and ignores the native checkpoint's saved system-message snapshot when rebuilding provider context.

## Token accounting

Preserved tokens are dialogue plus historical checkpoint tokens. Compactable tokens are only new raw state after the latest checkpoint. UI/debug accounting separately reports dialogue, historical checkpoints, total raw technical state before checkpointing, the older raw portion actually compacted, the newest raw tail intentionally kept, raw tool calls/results/reasoning/other, new checkpoint size, provider-reported prompt overhead, estimated system-prompt tokens, estimated tool-declaration tokens, residual provider overhead, context before/after, compacted raw tokens, and compression.

The current Pi usage at the boundary is the context-before baseline; after newly appended tool results it may include local estimation and is not guaranteed to be an exact provider token count. The compaction UI applies the current provider calibration consistently to every displayed component and reports context-after as the larger of a calibrated structural estimate and a calibrated estimate anchored to the last reported provider prefix. Conservative bytes/3 estimates remain internal for fit/safety decisions and structured audit fields. Delta-only fitting still ignores stale provider usage/calibration and estimates the whole request from scratch. For partial-delta checkpoints, `compactedRaw` is the selected older prefix and `remainingRawCompactable` includes both the deferred older suffix and the current batch.

## Certification

Real-Pi E2E recovery certification covers both delta-only entry points. The direct-overflow case makes a post-checkpoint live request report 56,172 prompt tokens for a 50,000-token model window and stop with `length`; checkpoint #2 then uses `delta-only`. A second case makes the cache-friendly checkpoint request technically fit but forces that summary itself to stop at `length`; the extension must retry the same exact delta as delta-only and persist checkpoint #2. Unit/integration coverage also certifies a tool-bearing live turn whose summary truncates and an oversized multi-batch delta that checkpoints only the oldest fitting prefix while carrying the rest raw.

The certifications assert that a delta-only request carries the exact raw tool call/result and correct absolute user ordinal while excluding preserved dialogue, historical checkpoints and the current truncated assistant when a prior checkpoint boundary exists. They then resume/continue Pi and inspect the actual next provider payload: compacted raw traffic is absent, immutable checkpoints/dialogue remain, response headroom is usable, and the model completes normally. Persisted JSONL still contains original raw tool traffic, so recovery changes only model-visible context.

## Observability

`debugFile` is rolling JSONL capped at 1 MiB and is written only when `debug: true`; `debug: false` never creates or touches it. Runtime filesystem writes by this extension are confined to the debug logger. Interactive TUI sessions never receive raw debug stderr writes; Pi notifications own user-visible status and JSONL owns structured diagnostics. Transient provider retry schedules and semantic summary retries/delta-only transitions are shown as notifications so a long compaction does not look hung. Full provider tool declarations are never persisted: `provider_request` records tool count, names, and a short declaration-set hash; payload/audit records store tool names only. Ordinary `debug: true` is structural: `preserve_compaction` records per-message role/kind/source-entry/checkpoint/token/hash metadata, raw delta boundaries, checkpoint hashes, token accounting and cache-prefix divergence, while `post_compaction_context` records the actual next provider message index, tool names and exact shared-prefix counts without message bodies. Full provider message payloads are forensic-only under `debugPayloads: true` through `payload_dump`; in that mode `preserve_compaction` may additionally carry full predicted `contextBefore`/`contextAfter`. Live provider input/output/reasoning counts, cache read/write counts, and stop reason are added as scalar fields to the existing `dynamic_compaction_pressure` record rather than a separate per-turn record. This separation prevents one large conversation snapshot from evicting most of the useful 1 MiB event history.
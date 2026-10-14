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

Summary requests are forward continuations of the live conversation whenever they fit. Historical checkpoints remain in the request only as immutable prefix context; they are not material to resummarize.

After compaction, cache divergence should begin only where newly compacted raw tool/reasoning state was removed. Earlier dialogue and checkpoints must remain stable.

Cache hit/miss outcomes are observability only. Every checkpoint is planned from the current live context as a forward continuation; `cacheRead: 0` never suppresses a later checkpoint, changes summary scope, or delegates compaction semantics to Pi. Transient provider errors during summary generation are retried independently using Pi's effective `settings.retry` policy; cache metrics never influence that retry decision.

Preserve mode owns a single `reserveTokens` policy instead of inheriting Pi's fixed reserve or layering extra 90%/2048-token margins. `preserveReserveTokens(contextWindow)` uses the fitted curve `round(88319.65 + (1468.926 - 88319.65) / (1 + (contextWindow / 1413076)^0.7096055))`. Every `turn_end` runs after the completed turn is represented in Pi's current context usage, so trigger directly when that usage reaches `contextWindow - reserveTokens` and older raw state exists before the current assistant message; the locally estimated current-batch size is for raw-tail accounting and must not be added to current usage again. This includes tool-free `length`/error/final turns, allowing a raw batch carried by the previous checkpoint to become eligible without requiring another tool call. The reserve is refreshed on session start, model selection and user input, with a model-aware fallback if the model/window changes unexpectedly.

The triggering assistant/tool batch is an atomic raw tail: summarize only older raw technical state from the previous provider prefix, append the new immutable checkpoint, then keep that current batch raw after it. It becomes eligible at the following `turn_end`. Normal preserve summaries remain forward continuations for cache reuse. If a `length` turn proves that the already-sent provider prefix is itself too large to append the summary ask, recovery may use a minimal cold rewind containing only a tiny recovery system/developer instruction, the exact compactable technical delta, and the checkpoint ask; this is the only automatic preserve rewind. Preserved dialogue, historical checkpoints, and the current `length` assistant are excluded from that cold request. Because it is a new prompt, recovery fit must ignore provider `usage` carried by raw assistant messages and must not reuse a token-scale ratio calibrated on the old full prefix; estimate the cold request from scratch with the conservative UTF-8 bytes/3 baseline plus normal uncertainty margin. The checkpoint's model-visible message must carry the checkpoint entry's append timestamp (or a synthetic timestamp newer than the branch for previews), and restored historical assistant prose before that checkpoint must expose zero prompt usage. Pi's estimator otherwise retains an older assistant usage sample even after the newer checkpoint invalidates raw-tail assistant usage; that stale sample still counts removed tool state and can clamp the first post-checkpoint response to one token. Summary output may use up to `reserveTokens`, clipped only by the summarizer model and actual request fit; there is no independent `summaryMaxTokens` policy. Pi-native automatic compaction is disabled in memory for eligible preserve-mode sessions, and native threshold/overflow hooks are cancelled rather than used as fallbacks. A real manual `/compact` is different: it deliberately routes through the extension-owned preserve summarization path immediately and Pi persists the extension-provided result as an append-only preserve-marked compaction checkpoint; earlier active checkpoints remain in reconstructed context. Because Pi prepares a manual compaction before firing extension hooks, preserve mode sets only the in-memory `keepRecentTokens` to 1 (with native automatic compaction still disabled) so a short but tool-bearing session cannot be rejected before our hook.

## Token accounting

Preserved tokens are dialogue plus historical checkpoint tokens. Compactable tokens are only new raw state after the latest checkpoint. UI/debug accounting separately reports dialogue, historical checkpoints, total raw technical state before checkpointing, the older raw portion actually compacted, the newest raw tail intentionally kept, raw tool calls/results/reasoning/other, new checkpoint size, provider-reported prompt overhead, estimated system-prompt tokens, estimated tool-declaration tokens, residual provider overhead, context before/after, reclaimed tokens, and compression.

The current Pi usage at the boundary is a trigger input, not necessarily an exact provider token count once new tool results have been appended. When the current assistant exposes non-zero provider usage, post-compaction estimation anchors to that exact pre-assistant provider prefix. New/unreported content uses at least the conservative UTF-8 bytes/3 estimate even when historical calibration would scale downward. The estimator compares that anchored delta estimate with a full structural messages-plus-tool-declarations estimate and keeps the larger value. Recovery-rewind fitting is different: the whole recovery prompt is unseen, so stale provider usage/calibration from the original full-prefix request is ignored and the cold delta is estimated from scratch. All context-after and component counts remain estimates and must be labelled as such.

## Certification

The real-Pi E2E recovery certification deliberately reproduces the production failure shape: normal checkpoint #1 leaves a large raw tool batch; the next provider request reports 56,172 prompt tokens for a 50,000-token model window and stops with `length`; checkpoint #2 therefore uses `recovery-rewind`. The test asserts that the cold summary request carries the exact raw tool call (ID, name and arguments), the complete large tool result, and the correct absolute user ordinal, while excluding preserved dialogue, checkpoint #1, previously compacted tool state, and the current truncated assistant.

The same certification resumes the persisted Pi session and inspects the actual next provider payload. The provider-message prefix before the removed raw batch must be byte-for-byte identical to the oversized pre-recovery request; the raw call/result must be absent; both immutable checkpoints and preserved dialogue must be present; the current `length` tail must remain raw; response headroom must be greater than one token; and the mock model must complete a normal response. The persisted JSONL must still contain the original raw tool traffic. This provider-level assertion is the recovery equivalent of `post_compaction_context`; the in-memory pending marker cannot cross a Pi process restart.

## Observability

`debugFile` is rolling JSONL capped at 1 MiB and is written only when `debug: true`; `debug: false` never creates or touches it. Runtime filesystem writes by this extension are confined to the debug logger. Full provider tool declarations are never persisted: `provider_request` records tool count, names, and a short declaration-set hash; payload/audit records store tool names only. `preserve_compaction` records predicted context before/after, per-message role/kind/source-entry/checkpoint/token/hash metadata, raw delta entry boundaries, historical checkpoint IDs/hashes, token accounting, and cache-prefix divergence. `post_compaction_context` records the actual next provider messages, tool names, and exact shared-prefix diagnostics.
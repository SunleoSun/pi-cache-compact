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

Preserve mode owns a single `reserveTokens` policy instead of inheriting Pi's fixed reserve or layering extra 90%/2048-token margins. `preserveReserveTokens(contextWindow)` uses the fitted curve `round(88319.65 + (1468.926 - 88319.65) / (1 + (contextWindow / 1413076)^0.7096055))`. Tool-bearing `turn_end` runs after the completed batch is already represented in Pi's current context usage, so trigger directly when that usage reaches `contextWindow - reserveTokens`; the locally estimated batch size is for raw-tail accounting and must not be added to current usage again. The reserve is refreshed on session start, model selection and user input, with a model-aware fallback if the model/window changes unexpectedly.

The triggering assistant/tool batch is an atomic raw tail: summarize only older raw tool/reasoning state from the previous provider prefix, append the new immutable checkpoint, then keep that newest batch raw after it. It becomes eligible for the following checkpoint. The checkpoint's model-visible message must carry the checkpoint entry's append timestamp (or a synthetic timestamp newer than the branch for previews), and restored historical assistant prose before that checkpoint must expose zero prompt usage. Pi's estimator otherwise retains an older assistant usage sample even after the newer checkpoint invalidates raw-tail assistant usage; that stale sample still counts removed tool state and can clamp the first post-checkpoint response to one token. Summary output may use up to `reserveTokens`, clipped only by the summarizer model and actual request fit; there is no independent `summaryMaxTokens` policy. Pi-native automatic compaction is disabled in memory for eligible preserve-mode sessions, and native threshold/overflow hooks are cancelled rather than used as fallbacks. A real manual `/compact` is different: it deliberately routes through the extension-owned preserve summarization path immediately and Pi persists the extension-provided result as an append-only preserve-marked compaction checkpoint; earlier active checkpoints remain in reconstructed context. Because Pi prepares a manual compaction before firing extension hooks, preserve mode sets only the in-memory `keepRecentTokens` to 1 (with native automatic compaction still disabled) so a short but tool-bearing session cannot be rejected before our hook.

## Token accounting

Preserved tokens are dialogue plus historical checkpoint tokens. Compactable tokens are only new raw state after the latest checkpoint. UI/debug accounting separately reports dialogue, historical checkpoints, total raw technical state before checkpointing, the older raw portion actually compacted, the newest raw tail intentionally kept, raw tool calls/results/reasoning/other, new checkpoint size, provider-reported prompt overhead, estimated system-prompt tokens, estimated tool-declaration tokens, residual provider overhead, context before/after, reclaimed tokens, and compression.

Provider-reported `tokensBefore` and the total provider prompt overhead derived from it are factual. System-prompt/tool-declaration/residual splits and local after/breakdown counts are estimates and must be labelled as such.

## Observability

`debugFile` is rolling JSONL capped at 1 MiB and is written only when `debug: true`; `debug: false` never creates or touches it. Runtime filesystem writes by this extension are confined to the debug logger. Full provider tool declarations are never persisted: `provider_request` records tool count, names, and a short declaration-set hash; payload/audit records store tool names only. `preserve_compaction` records predicted context before/after, per-message role/kind/source-entry/checkpoint/token/hash metadata, raw delta entry boundaries, historical checkpoint IDs/hashes, token accounting, and cache-prefix divergence. `post_compaction_context` records the actual next provider messages, tool names, and exact shared-prefix diagnostics.
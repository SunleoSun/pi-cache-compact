---
description: Append-only checkpoint cache-prefix invariants, token accounting, and observability.
---
# Compaction cache model

## Canonical invariant

After a preserve compaction the provider-visible history is:

```text
immutable user/assistant dialogue
+ immutable historical Tool Context Checkpoints
+ NEW delta Tool Context Checkpoint
+ later live state
```

The old prefix must remain unchanged. A later checkpoint summarizes only tool activity after the previous checkpoint.

## Cache behavior

Summary requests are forward continuations of the live conversation whenever they fit. Historical checkpoints remain in the request only as immutable prefix context; they are not material to resummarize.

After compaction, cache divergence should begin only where newly compacted raw tool/reasoning state was removed. Earlier dialogue and checkpoints must remain stable.

## Token accounting

Preserved tokens are dialogue plus historical checkpoint tokens. Compactable tokens are only new raw state after the latest checkpoint. UI/debug accounting separately reports dialogue, historical checkpoints, raw tool calls/results/reasoning/other, new checkpoint size, provider-reported prompt overhead, estimated system-prompt tokens, estimated tool-declaration tokens, residual provider overhead, context before/after, reclaimed tokens, and compression.

Provider-reported `tokensBefore` and the total provider prompt overhead derived from it are factual. System-prompt/tool-declaration/residual splits and local after/breakdown counts are estimates and must be labelled as such.

## Observability

`debugFile` is rolling JSONL capped at 1 MiB and is written only when `debug: true`; `debug: false` never creates or touches it. Runtime filesystem writes by this extension are confined to the debug logger. `preserve_compaction` records predicted context before/after, provider tools, per-message role/kind/source-entry/checkpoint/token/hash metadata, raw delta entry boundaries, historical checkpoint IDs/hashes, token accounting, and cache-prefix divergence. `post_compaction_context` records the actual next provider messages/tools and exact shared-prefix diagnostics.
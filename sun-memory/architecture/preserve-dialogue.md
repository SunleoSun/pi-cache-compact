---
description: Canonical preserve-dialogue semantics, checkpoint lifecycle, and compatibility rules.
---
# Preserve dialogue architecture

## Owner

`src/preserve.ts` owns what survives preserve-mode compaction and how the model-visible conversation is rebuilt. `src/extension.ts` owns trigger/runtime integration; `src/build.ts` owns summary request planning/prompting.

## Permanent context

Preserve mode keeps these items byte-for-byte/semantically immutable after they enter history:
- every user message;
- every completed assistant response (`stopReason: "stop"` with no tool call), preserving its visible text blocks;
- every active historical Tool Context Checkpoint.

Assistant reasoning, assistant text from tool-use/interrupted/error/length responses, tool-call blocks, and tool-result messages are compactable technical state.

## Append-only checkpoints

Automatic preserve compaction appends one hidden `cache-compact-preserve-checkpoint` custom message. A real manual `/compact` uses the same preserve summarization semantics immediately (without waiting for reserve pressure) and is persisted by Pi as a preserve-marked immutable compaction checkpoint while earlier active checkpoints remain visible. Its returned `firstKeptEntryId` is the earliest transcript message, so Pi's native post-compaction TUI rebuild keeps the prior transcript on screen; provider context is still reconstructed by preserve mode and excludes compacted raw technical traffic. Pi stores a system-message snapshot on native compaction entries, but preserve restoration treats that snapshot as transport metadata rather than another checkpoint message so the canonical system prompt appears only once. Preserve mode forces Pi's in-memory `keepRecentTokens` to 1 while automatic compaction is disabled so Pi's manual `prepareCompaction` reaches the extension hook even for short sessions. Historical checkpoints are never replaced, merged, rewritten, or nulled by later compactions.

A new checkpoint covers raw technical state created after the latest active checkpoint and before the chosen raw-tail boundary. Normally that boundary is the current assistant message, so the current assistant/tool batch remains raw and becomes eligible at the following `turn_end`, including `length`/error/final turns. Summary creation first uses the cache-friendly live prefix. If that request cannot fit safely, preserve mode automatically uses a **delta-only summary** containing a tiny summary instruction, the exact technical delta, and the checkpoint ask. If a cache-friendly summary itself stops at `length`, retry that same exact delta once as delta-only regardless of the live turn's stop reason. If the complete delta-only request is too large to retain the normal output reserve, choose the latest safe earlier boundary, summarize the largest fitting older prefix, and carry the remaining suffix forward raw after the new checkpoint. Safe boundaries are before user/assistant messages, never before a tool result, so an assistant tool-call batch remains with its following results. With an existing checkpoint/raw-tail boundary, preserved dialogue and historical checkpoints stay out of delta-only requests. The ask still carries absolute owning user-message ordinals computed from the full branch. After success, context edits hide only the compacted technical entries; the new immutable checkpoint replaces them model-visibly while raw JSONL/TUI history remains append-only.

Checkpoint metadata carries its ordinal and the absolute user-message ordinals whose tool activity it covers. Successful compactions also persist a typed display report; automatic reports contain the summary, while manual reports contain statistics only beside Pi's native compaction card. Persistent report rendering is always the full body and does not collapse with Pi's global expanded-output flag.

## Summary semantics

The summary is result-oriented and grouped under `### User message N`. It records tool-evidenced findings, changes/validation, and unresolved state. It must not paraphrase preserved dialogue or promote assistant reasoning. The summary ask receives the exact absolute user-message ordinals covered by the delta, so even a delta-only request or a tool loop continuing across checkpoints cannot renumber the owning user turn. Recovery certification verifies this with a second-user raw batch: the delta-only request contains the complete call/result but the ask still names absolute user message 2.
## Compatibility

A legacy preserve-marked Pi compaction may act as an immutable baseline checkpoint. Checkpoints that an older plugin version already nulled remain ignored; the latest active aggregated legacy checkpoint becomes the baseline for future append-only deltas.
Fresh append-only sessions do not require a legacy baseline: custom preserve checkpoints must still be retained in model-visible order from the first checkpoint onward.
## Fail closed

Transient provider failures while generating a checkpoint use Pi's effective `settings.retry` policy and `pi-ai` retry classifier, matching Pi's own summarization path. A completed summary reply that contains a parsed tool call, textual tool-call syntax, or no visible summary text gets one deterministic text-only retry. That retry forces tool choice to `none` even when the cache-friendly first attempt mirrored the live request. Only after those recovery paths are exhausted (or for a non-retryable failure) does preserve mode fail closed.

If no safe prefix can fit a delta-only request because one indivisible technical unit itself exceeds the usable context, cancel/decline the preserve compaction rather than silently dropping state or rewriting preserved history. Multi-unit oversized deltas must first compact a fitting older prefix and carry the remaining suffix raw.
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

Automatic preserve compaction appends one hidden `cache-compact-preserve-checkpoint` custom message. A real manual `/compact` uses the same preserve summarization semantics immediately (without waiting for reserve pressure) and is persisted by Pi as a preserve-marked immutable compaction checkpoint while earlier active checkpoints remain visible. Preserve mode forces Pi's in-memory `keepRecentTokens` to 1 while automatic compaction is disabled so Pi's manual `prepareCompaction` reaches the extension hook even for short sessions. Historical checkpoints are never replaced, merged, rewritten, or nulled by later compactions.

A new checkpoint covers only raw tool/reasoning state created after the latest active checkpoint. The raw tool state is removed from model context through context edits, while the raw persisted session remains append-only for TUI/history.

Checkpoint metadata carries its ordinal and the absolute user-message ordinals whose tool activity it covers.

## Summary semantics

The summary is result-oriented and grouped under `### User message N`. It records tool-evidenced findings, changes/validation, and unresolved state. It must not paraphrase preserved dialogue or promote assistant reasoning. The summary ask receives the exact absolute user-message ordinals covered by the delta, so even an explicit dropped/rewind request or a tool loop continuing across checkpoints cannot renumber the owning user turn.
## Compatibility

A legacy preserve-marked Pi compaction may act as an immutable baseline checkpoint. Checkpoints that an older plugin version already nulled remain ignored; the latest active aggregated legacy checkpoint becomes the baseline for future append-only deltas.
Fresh append-only sessions do not require a legacy baseline: custom preserve checkpoints must still be retained in model-visible order from the first checkpoint onward.
## Fail closed

Transient provider failures while generating a checkpoint use Pi's effective `settings.retry` policy and `pi-ai` retry classifier, matching Pi's own summarization path. Only after that retry budget is exhausted (or for a non-retryable failure) does preserve mode fail closed.

If the complete new tool delta still cannot be summarized under preserve-mode constraints, cancel/decline the preserve compaction rather than silently leaving raw historical tool traffic or falling back to semantics that rewrite preserved state.
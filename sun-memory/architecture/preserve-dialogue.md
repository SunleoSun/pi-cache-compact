---
description: Canonical preserve-dialogue semantics, checkpoint lifecycle, and compatibility rules.
---
# Preserve dialogue architecture

## Owner

`src/preserve.ts` owns what survives preserve-mode compaction and how the model-visible conversation is rebuilt. `src/extension.ts` owns trigger/runtime integration; `src/build.ts` owns summary request planning/prompting.

## Permanent context

Preserve mode keeps these items byte-for-byte/semantically immutable after they enter history:
- every user message;
- every visible assistant text block;
- every active historical Tool Context Checkpoint.

Assistant reasoning, tool-call blocks, and tool-result messages are compactable technical state.

## Append-only checkpoints

Each successful preserve compaction appends one hidden `cache-compact-preserve-checkpoint` custom message. Historical checkpoints are never replaced, merged, rewritten, or nulled by later compactions.

A new checkpoint covers only raw tool/reasoning state created after the latest active checkpoint. The raw tool state is removed from model context through context edits, while the raw persisted session remains append-only for TUI/history.

Checkpoint metadata carries its ordinal and the absolute user-message ordinals whose tool activity it covers.

## Summary semantics

The summary is result-oriented and grouped under `### User message N`. It records tool-evidenced findings, changes/validation, and unresolved state. It must not paraphrase preserved dialogue or promote assistant reasoning. The summary ask receives the exact absolute user-message ordinals covered by the delta, so even an explicit dropped/rewind request or a tool loop continuing across checkpoints cannot renumber the owning user turn.
## Compatibility

A legacy preserve-marked Pi compaction may act as an immutable baseline checkpoint. Checkpoints that an older plugin version already nulled remain ignored; the latest active aggregated legacy checkpoint becomes the baseline for future append-only deltas.
Fresh append-only sessions do not require a legacy baseline: custom preserve checkpoints must still be retained in model-visible order from the first checkpoint onward.
## Fail closed

If the complete new tool delta cannot be summarized under preserve-mode constraints, cancel/decline the preserve compaction rather than silently leaving raw historical tool traffic or falling back to semantics that rewrite preserved state.
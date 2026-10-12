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
- every visible **assistant text** block, verbatim;
- every historical **Tool Context Checkpoint**, immutable after creation.

Assistant reasoning, tool calls and tool results are compactable technical state.

Preserve mode checkpoints at a tool-bearing `turn_end`, at the earlier of its dynamic 90% pressure limit or Pi's effective native threshold. It does not append a Pi `compaction` entry, so the raw/TUI transcript is not cleared. Instead it adds context edits that hide compacted tool/reasoning state from future model requests and appends one hidden checkpoint.

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

The original user prompt is already present verbatim, so the checkpoint identifies it only as `User message N` and does not paraphrase it. The extension also injects the exact absolute user-message ordinals covered by the new delta into the summary ask; this prevents a dropped/rewind request from renumbering a user turn merely because earlier dialogue is outside that request. A tool loop may continue across checkpoint boundaries; new tool evidence remains associated with the user message that initiated that work.

Historical checkpoints are immutable prefix context. A later summarization request must not repeat, merge, update or supersede them.

## Cache behavior

The summary request is normally a strict forward continuation of the live conversation: same system prompt, same tool declarations and same cached message prefix, then one extra user ask. `continuation: false` and `rewindWhenNeeded: true` are explicit opt-outs for servers where rewinding is acceptable.

After compaction, divergence should start only where newly compacted raw tool/reasoning state disappeared. User/assistant dialogue and older checkpoints stay stable.

If the full new tool delta cannot be summarized without violating preserve semantics, preserve mode fails closed rather than silently delegating to a lossy fallback.

## Compaction UI

A successful preserve checkpoint reports the trigger and token accounting, for example:

```text
[cache-compact] compact complete: normal (dynamic 90%)
context before: 35562 tok
context after: ~8590 tok
reclaimed: ~26972 tok

preserved dialogue: 2080 tok
 user messages: ~1220 tok
 assistant text: ~860 tok
historical checkpoints: 310 tok (1)
new raw compactable: 27192 tok
  tool calls: ~...
  tool results: ~...
  reasoning: ~...
  other: ~...
new checkpoint #2: 220 tok
system prompt: ~4100 tok
tool declarations: ~1650 tok
other provider overhead: ~540 tok
checkpoint user messages: 5, 6
compression: 123.6x
```

`context before` is Pi/provider-reported usage. The breakdown and context-after values are local estimates and are marked with `~` where appropriate.

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
| `summaryMaxTokens` | Explicit summary-output ceiling; otherwise derived from Pi/model/reclaimed state. |
| `summaryReasoningEffort` | Explicit summary effort. Omitted mirrors the last live request. |
| `cacheRetention` | Provider cache retention: `none`, `short`, `long`; default `short`. |
| `toolChoice` | Summary request tool choice: `none` or `auto`; default `none`. Tool declarations remain for prefix identity. |
| `continuation` | Prefer a forward continuation of the cached conversation. Default `true`. |
| `rewindWhenNeeded` | Permit dropped-span rewind when no continuation fits. Default `false`. |
| `debug` | Master debug switch. `false` (default) disables stderr/structured debug output and never creates/touches `debugFile`. |
| `debugFile` | Absolute JSONL path for structured diagnostics. The file is written only when `debug: true`. |
| `debugPayloads` | Legacy optional full payload dumps around compaction for `compare-dumps.mjs`. |

## Debugging and observability

`debugFile` is written only when `debug: true` and a path is configured; `debug: false` never creates or touches it. It is a **rolling JSONL file with a hard 1 MiB limit**. Before appending a record that would exceed the limit, the logger evicts the oldest complete JSONL records. If one record alone is larger than 1 MiB, it is replaced by a small `log_record_oversize` marker. The logger never throws into the compaction path. The extension itself performs no other runtime filesystem writes; Pi still persists its own normal session/transcript files.

Provider cache metrics such as `cacheRead` and `cacheWrite` are observability only. They are logged, but never suppress, defer, retry-gate, or otherwise reshape compaction.

The canonical records are:

- `preserve_compaction` — one self-contained audit record per successful preserve checkpoint. It contains checkpoint number/scope, absolute covered user-message ordinals, raw branch entry IDs/boundaries, historical checkpoint IDs/hashes, the provider tool declarations captured before compaction, full predicted model-visible `contextBefore` and `contextAfter`, a per-message index (`role`, semantic kind, source session-entry ID, checkpoint number, estimated tokens, hash), complete token accounting, compression/reclaimed estimates, and a structural stable-prefix diagnostic including the first divergence.
- `post_compaction_context` — the **actual next provider** messages/tool declarations after the checkpoint, plus an exact provider-message shared-prefix count against the previous live request and hashes of the checkpoints present in the branch.
- `provider_request`, `provider_headers`, `provider_response` — request/cache fingerprints and redacted transport diagnostics.
- `summary_start`, `summary_result`, `summary_retry` — summary lifecycle.

The debug context contains conversation text and tool-derived state. Treat it as private and do not commit/share it casually.

`debugPayloads: true` still emits legacy `payload_dump` records (`live_before`, `summarization`, `live_after`) for `scripts/compare-dumps.mjs`, but the canonical compaction audit no longer depends on that option.

## Token accounting

Preserve-mode accounting separates:

- provider-reported context before;
- estimated non-system context before, system prompt, tool declarations, and residual provider overhead;
- preserved dialogue, with separate user-message and visible-assistant-text estimates;
- historical checkpoint tokens + count;
- new raw compactable tool calls/results/reasoning/other;
- new checkpoint size and explicit `remainingRawCompactable: 0` on successful preserve compaction;
- estimated context after, reclaimed tokens and compression.

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
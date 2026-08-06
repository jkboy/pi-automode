# Observability logging

Auto mode can write a JSONL observability log next to the current Pi session file, so you can inspect decisions and classifier usage. It is off by default and fail-open: a write error never changes an allow/block decision.

## Enabling

Set `autoMode.log` in any Pi-owned config source (`~/.pi/agent/automode.json`, `.pi/automode.local.json`, or `PI_AUTOMODE_SETTINGS_JSON`):

```json
{
  "autoMode": {
    "log": {
      "enabled": true,
      "classifierIo": false
    }
  }
}
```

- `enabled` — write one `decision` line per tool-call decision and one ccusage-compatible `message` line per classifier model response.
- `classifierIo` — also write the classifier's prompt, raw model responses, and parsed decision for classifier-routed actions. Off by default; see [Privacy](#privacy) below.

Fields merge independently across config scopes (set `enabled` globally and `classifierIo` per project, for example). Shared project `.pi/automode.json` cannot set `log` — it follows the same `autoMode` exclusion as the rest of the config. Shape is validated and reported by `/automode config`.

Logging only writes entries while auto-mode is **enabled**. With auto-mode off, no tool calls reach the hook, so no entries are produced.

## Log file location

The log file is colocated with the current Pi session file, with `-pi-automode` inserted before the extension:

```text
<session-file>                       →  <dir>/<id>.jsonl
<session-file>-pi-automode.jsonl     →  <dir>/<id>-pi-automode.jsonl
```

For example: `~/.pi/agent/sessions/<slug>/<id>-pi-automode.jsonl`. If no session file is set, it falls back to `<sessionDir>/<sessionId>-pi-automode.jsonl`. Run `/automode config` to see the resolved path.

There is one combined file per session. Each line is one JSON object with a `type` discriminator. Entries for the same tool call share a `decisionId`.

## Entry types

### `decision`

One per tool-call decision. Every allow and every block goes through exactly one of these.

| field | meaning |
| --- | --- |
| `ts` | ISO timestamp |
| `decisionId` | links to the `classifier` entry (if any) for the same call |
| `sessionId` | Pi session id |
| `cwd` | working directory |
| `tool` | tool name, e.g. `bash`, `write` |
| `summary` | `actionSummary` — tool name + input JSON (truncated) |
| `kind` | enforcement path: `permissions.deny`, `permissions.ask`, `deterministic-hard-deny`, `classifier`, or `read-only` |
| `outcome` | `allow` or `block` |
| `reason` | the reason string (classifier reason, or the deterministic/permission reason) |
| `classifierModel` | the configured classifier model, when relevant |
| `reasoning` | classifier reasoning mode and requested/effective level; see below |

The reasoning field records either server-default mode:

```json
{"mode":"server-default"}
```

or an explicit request after model-level clamping:

```json
{"mode":"explicit","requestedLevel":"max","effectiveLevel":"xhigh"}
```

Classifier-routed decisions contain the effective level once the configured model resolves, even when `classifierIo` is off or authentication then fails. If the configured model itself cannot be resolved, an explicit entry records `requestedLevel` without `effectiveLevel` because no model-supported level exists. A local permission, deterministic, or read-only decision does not run the classifier and likewise may omit `effectiveLevel`. In `server-default` mode, the concrete server-selected level is not observable and is not inferred.

### `message` (classifier usage)

One per classifier model response, including malformed responses that trigger a retry. Written whenever logging is enabled, before the matching `decision` line. Its shape is intentionally compatible with `ccusage pi`:

| field | meaning |
| --- | --- |
| `timestamp` | ISO timestamp from the classifier response |
| `message.role` | always `assistant` |
| `message.model` | model ID returned by the classifier provider |
| `message.usage` | provider-reported input, output, cache, total-token, and cost fields |

`ccusage` reports this sidecar as a separate `-pi-automode` session. This entry contains no prompt or response text, so it is written even when `classifierIo` is off.

### `classifier`

Written only for classifier-routed actions, and only when `classifierIo: true`. It follows any classifier-usage `message` entries and precedes the matching `decision` line in the file.

| field | meaning |
| --- | --- |
| `ts` | ISO timestamp |
| `decisionId` | matches the `decision` entry for the same call |
| `model` | classifier model used, e.g. `anthropic/claude-haiku-4` |
| `reasoning` | `server-default`, or the explicit requested and effective model-supported level |
| `prompt.system` | the full system policy with `environment`/`allow`/`soft_deny`/`hard_deny` rules interpolated |
| `prompt.context` | the shared context message: loaded project instructions + classifier transcript + action |
| `prompt.fastInstruction` | the exact one-token filter instruction |
| `prompt.detailedInstruction` | the exact structured-review instruction |
| `attempts` | one entry per classifier model call (see below) |
| `durationMs` | total classifier time |
| `parsed` | the final decision that was acted on (`{ decision, tier, reason }`) |

Each `attempts[]` entry is `{ stage, attempt, response?, parsed?, error?, durationMs, retryDelayMs? }`:

- `stage` — `fast` for the one-token filter or `detailed` for structured review.
- `response` — `{ stopReason, text, model, timestamp, usage, errorMessage? }`, the raw model output and provider-reported usage for that call, including provider-reported errors and aborted requests.
- `parsed` — the decision parsed from the response, or absent if it did not parse.
- `error` — present when the call threw (network/auth); `response` is then absent.
- `retryDelayMs` — present on a failed attempt when a backoff retry follows; records the scheduled wait.

This records both stages, retries, and fail-closed cases verbatim. A fast allow has one entry. A review followed by malformed detailed JSON and a successful retry has three entries.

## Privacy

`prompt.context` is the shared content sent to both classifier stages: loaded project instructions, selected transcript evidence, and the action being classified. The stage-specific final instructions are logged separately. See [Auto-mode classifier flow → What is sent to the classifier](automode-classifier-flow.md#what-is-sent-to-the-classifier) for how the evidence is assembled and truncated.

The log records this payload locally, but the same data is also sent to the classifier model endpoint on every classifier-routed call. If `classifierModel` points at a cloud provider, that payload leaves the machine. Enable `classifierIo` when debugging classifier behavior or tuning rules; leave it off for routine outcome logging.

## Sizing

- `decision` line: ~0.4–2 KB (driven by `summary`, which carries the tool input, capped at 6 KB).
- `classifier` line: ~5 KB fixed policy plus loaded project instructions, selected transcript evidence, stage instructions, and recorded responses.

Transcript evidence is bounded separately by `autoMode.maxUserTranscriptTokens` and `autoMode.maxToolTranscriptTokens`, both 4000 approximate tokens by default. Assistant prose and tool results are not included. Provider cache hits can reduce billed or processed input where supported, but the log still records the full classifier payload.

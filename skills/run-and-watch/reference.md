# Run and watch: reference

## `GetExecutionStatus`

Arguments: `executionId` (required), `projectId` (optional; or `context.projectId`).

It needs View access to the run's project, never waits, and answers:

```json
{
  "executionId": "...",
  "status": "Running",
  "terminal": false,
  "progress": { "stepsTotal": 6, "stepsDone": 2, "currentStep": { "stepOrder": 3, "label": "...", "stepType": "..." } },
  "creditsCharged": 12.5,
  "errorMessage": null,
  "outputs": [ { "outputId": "...", "stepOrder": 2, "label": "..." } ],
  "retryAfterSeconds": 30,
  "hint": "..."
}
```

`status` is `Queued`, `Running`, `Passed`, `Failed` or `Cancelled`; `terminal` is true for the last
three. `hint` is always present (it says the run is finished once it is final) and `retryAfterSeconds` is
null once the run is final; both carry information while the run is going (15 seconds for a run under two
minutes old, 30 up to ten minutes, 60 after that). Do not poll in a loop.

## Run-resource subscriptions

The MCP server serves the resource `reelbolt://runs/{executionId}` with an optional
`?project={projectId}`. A client that subscribes receives `notifications/resources/updated` when the
run changes; if the subscribe request carried a progress token it also receives
`notifications/progress` with the steps done. Delivery is best effort. On a notification, call
`GetExecutionStatus` to read the state. A subscription ends when the run is final, when it is
unsubscribed, after its time-to-live (120 minutes by default), or when the session closes. The server
limits subscriptions per session (5), per person (10) and in total, so subscribe only to runs you are
following.

## `reelbolt-mcp-watch`

```bash
reelbolt-mcp-watch <executionId> [--project <projectId>] [--max-minutes 120]
```

It calls `GetExecutionStatus`, sleeps for the answer's `retryAfterSeconds` (5 seconds when absent, clamped to
5-60; after a failed read it waits 5, 10, 20, then 40 seconds and exits after five failures in a
row), and prints one plain line each time status, steps done or current
step changes. Examples of lines: `running 2/6 - <step label>`, `finished: Passed`,
`finished: Failed - <error, up to 200 characters>`, `finished: Cancelled`, `lost contact with ReelBolt`, `still running after <N> minutes`.

| Exit code | Meaning |
|---|---|
| `0` | The run reached a final state (`Passed`, `Failed` or `Cancelled`). The last stdout line says which. |
| `1` | Authentication failed, five consecutive failed reads, a missing environment variable, or `--max-minutes` elapsed. Authentication and missing-variable reasons go to stderr; lost contact and the time limit are the last stdout line. |
| `2` | Bad arguments. |

Stdout carries only the lines; diagnostics go to stderr, and the token is never printed.

### What it needs

- `INFERENCE_API_URL`: the base URL of the ReelBolt Inference API.
- `REELBOLT_MCP_TOKEN`: a ReelBolt bearer token for the same account.
- Node.js 22.23.1 or later. The command is the `reelbolt-mcp-watch` binary of the ReelBolt server's `mcp`
  package. It is not part of this plugin. Self-hosters get it with their ReelBolt installation.

The plugin's browser sign-in stores its credential inside Claude Code, where no command can read it.
So with the plugin alone the watch command usually cannot authenticate. If `command -v
reelbolt-mcp-watch` finds nothing, or either variable is unset, do not ask for a token in the chat.
Say so and use the subscription or `GetExecutionStatus`.

### Monitor recipe

1. `ExecuteWorkflow` returns the `executionId`.
2. Start Monitor with the command `reelbolt-mcp-watch <executionId> --project <projectId>`.
3. For every line, update the user in one sentence. Do not call other ReelBolt tools just because a
   line arrived.
4. When Monitor reports the command has exited with `0`, the last line starts with `finished:`. Call
   `GetExecutionStatus` for outputs and credits, or `GetWorkflowExecution` for per-step detail, and
   report.
5. On exit `1`, read the last stdout line and stderr. If stderr says authentication failed or a
   variable is missing, switch to `GetExecutionStatus` honoring `retryAfterSeconds`. If the last line
   is `lost contact with ReelBolt` or `still running after <N> minutes`, the run may still be going:
   check once with `GetExecutionStatus`.

## Chat-only: `WatchExecution`

The dashboard assistant has a `WatchExecution` tool that wakes its chat when a run ends. It is not
offered over MCP, so Claude Code never has it.

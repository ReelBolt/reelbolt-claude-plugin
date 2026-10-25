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

## `reelbolt-watch`

Run it as `node "${CLAUDE_PLUGIN_ROOT}/bin/reelbolt-watch.mjs" ...` (Node.js 22 or later):

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/reelbolt-watch.mjs" <executionId> --project <projectId> [--max-minutes N]
node "${CLAUDE_PLUGIN_ROOT}/bin/reelbolt-watch.mjs" login --server <ReelBolt MCP URL> [--no-browser]
node "${CLAUDE_PLUGIN_ROOT}/bin/reelbolt-watch.mjs" status
node "${CLAUDE_PLUGIN_ROOT}/bin/reelbolt-watch.mjs" logout
```

The watch form calls `GetExecutionStatus`, waits the answer's `retryAfterSeconds` (clamped to
5-60 seconds; after a failed read it waits 5, 10, 20, then 40 seconds and gives up after five
failures in a row), and prints one plain line each time status, steps done or current step changes.
Lines: `running 2/6 - <step label>`, `finished: Passed`,
`finished: Failed - <error, up to 200 characters>`, `finished: Cancelled`,
`lost contact with ReelBolt`, `still running after <N> minutes`, `cannot read this run: access denied`,
`cannot read this run: <the server's message>` (unknown run, or the project is missing or not yours).

| Exit code | Meaning |
|---|---|
| `0` | The run reached a final state (`Passed`, `Failed` or `Cancelled`). The last stdout line says which. |
| `1` | A problem: lost contact, access denied, or `--max-minutes` elapsed. The reason is the last stdout line or on stderr. |
| `2` | Bad arguments. |
| `3` | Sign-in needed. The line says `not signed in`, `sign-in expired` or `sign-in unusable`. |

Stdout carries only the lines; diagnostics go to stderr. The token is never printed.

### Sign-in

`login --server <url>` takes the same address as the plugin's `server_url` (ending in `/mcp`). It
prints an address and opens the browser, where the user approves read-only access to run status for
one workspace. The credential is stored in `watch-credentials.json` in the ReelBolt config folder
(`$REELBOLT_WATCH_HOME`, else `$XDG_CONFIG_HOME/reelbolt`, else `~/.config/reelbolt`; on Windows
`%APPDATA%\reelbolt`), readable only by the user. `status` shows whether a sign-in exists; `logout`
revokes it on the server and deletes the file. The credential reads run status and nothing else.

### Monitor recipe

1. `ExecuteWorkflow` returns the `executionId`.
2. Start Monitor with `node "${CLAUDE_PLUGIN_ROOT}/bin/reelbolt-watch.mjs" <executionId> --project <projectId>`,
   then end the turn.
3. For every line, update the user in one sentence. Do not call other ReelBolt tools just because a
   line arrived.
4. When the command exits with `0`, the last line starts with `finished:`. Call `GetExecutionStatus`
   for outputs and credits, or `GetWorkflowExecution` for per-step detail, and report.
5. On exit `3`, follow the sign-in steps in `SKILL.md`, then start Monitor again.
6. On exit `1`, read the last line. For `lost contact with ReelBolt` or `still running after <N> minutes`
   the run may still be going: check once with `GetExecutionStatus`. For `cannot read this run: access
   denied`, the signed-in workspace does not own the run; say so and use `GetExecutionStatus`. For any
   other `cannot read this run: ...` line, the run id or project id is wrong: check them with
   `ListWorkflowExecutions` and start again.

## Chat-only: `WatchExecution`

The dashboard assistant has a `WatchExecution` tool that wakes its chat when a run ends. It is not
offered over MCP, so Claude Code never has it.

---
description: Start a ReelBolt run and wait for it WITHOUT blocking or polling in a loop - GetExecutionStatus, run-resource subscriptions, or the reelbolt-mcp-watch CLI under Claude Code's Monitor tool. Use when asked to run a workflow and report back, to check whether a run has finished, or to follow a run's progress.
---

# Start a run and wait for it without blocking

A run takes minutes. Never sit in a loop calling a tool, and never use `WaitForExecution`: it is
removed from the catalog (an old script that still sends the name gets `GetExecutionStatus`'s answer
plus a `deprecated` field). Tools are named `mcp__plugin_reelbolt_reelbolt__<ToolName>`.

## Recipe

1. **Start it.** Follow the `author-workflow` and `consent-and-budget` rules, then call
   `ExecuteWorkflow` (`workflowId`, optional `brief`, plus the style and paid-clip answers the user
   gave). Read `executionId` from the receipt.
2. **Look once.** `GetExecutionStatus` with `executionId` (and `projectId` or `context.projectId`).
   It answers at once and never waits.
3. **Pick how to wait**, in this order:
   - **`reelbolt-mcp-watch` under Monitor**, if the command exists on this machine and
     `INFERENCE_API_URL` and `REELBOLT_MCP_TOKEN` are set (run `command -v reelbolt-mcp-watch`).
     Start Monitor on `reelbolt-mcp-watch <executionId> --project <projectId>`. Each stdout line is
     one notification; the command exits `0` when the run is finished.
   - **A run-resource subscription**, if your client supports MCP resource subscriptions:
     subscribe to `reelbolt://runs/<executionId>?project=<projectId>`.
   - **`GetExecutionStatus` again**, only after `retryAfterSeconds` has passed, between other work.
     Do not poll faster.
4. **React.** On each line, tell the user the new step. On the line starting `finished:`, call
   `GetExecutionStatus` (status, outputs) or `GetWorkflowExecution` (per-step detail, errors) and
   report with the `inspect-run` skill.

Read [`reference.md`](./reference.md) for the exact watch CLI lines, exit codes and setup, the
subscription details and the fallbacks.

## Rules

- The watch CLI ships with the ReelBolt server's `mcp` package, not with this plugin. This plugin
  signs in through the browser and holds no token a command could read. If the CLI or
  `REELBOLT_MCP_TOKEN` is missing, do not ask the user to paste a token; use the subscription or
  `GetExecutionStatus` with `retryAfterSeconds`.
- Exit code `0` means the run reached a final state, including `Failed` and `Cancelled`. Read the
  last line, not the exit code, to learn the outcome.
- A run that is `terminal: false` with `retryAfterSeconds` set is healthy. Do not re-run it.

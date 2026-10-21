---
description: Inspect a ReelBolt project's workflows and the status of a recent run through the ReelBolt MCP tools. Use when asked what workflows a ReelBolt project has, how a run went, which step failed, or why an execution is stuck.
---

# Inspect a ReelBolt project and its runs

Answer "what workflows does this project have?" and "how did the last run go?" with the ReelBolt MCP
tools. The server is registered as `reelbolt`, so in this session its tools are named
`mcp__plugin_reelbolt_reelbolt__<ToolName>`.

## How page context crosses MCP

Most project-scoped tools take **no `projectId` argument**. The MCP server adds one optional
`context` object to every bridged tool's input schema:

```json
"context": {
  "projectId": "<uuid>",
  "workflowId": "<uuid>",
  "imageDocumentId": "<uuid>"
}
```

All three properties are optional. The server removes `context` from the call's `arguments` and
sends it as the separate `context` field of the tool call, so it never collides with a tool's own
arguments. A tool's real arguments — `workflowId`, `limit`, `executionId` — stay in `arguments` as
normal.

## Find the project

`ListProjects` needs **no project in context** and lists the projects the caller owns (id, name,
description, status, timestamps). Use it to turn a project name the user mentioned into a
`projectId`. `GetProject` then returns one project with a `fileCount` and `workflowCount`; omit its
`projectId` argument to read the project in `context`, or pass one explicitly.

The project id is also the UUID in the ReelBolt dashboard URL for the project. Never invent one, and
never assume the first project in a list is the one the user meant — ask if it is ambiguous.

## Flow

1. **Resolve the project** — `ListProjects` with no `context`. Keep the `projectId` you need.
2. **Orient on the project's files** (optional) — `ListProjectFiles` with
   `context: { "projectId": "<uuid>" }`. File metadata only; it does not return file contents.
3. **List the workflows** — `ListWorkflows` with `context: { "projectId": "<uuid>" }`. Returns id,
   name, step count, `requiresUserInput` and timestamps.
4. **Read one workflow's steps** — `GetWorkflow` with
   `context: { "projectId": "<uuid>", "workflowId": "<uuid>" }`, or omit `workflowId` to use the
   workflow open on the user's page. It returns every step's agent, label, step type and full
   configuration JSON — in exactly the shape `ValidateWorkflow` and `ProposeWorkflow` accept.
5. **List recent runs** — `ListWorkflowExecutions` with `context: { "projectId": "<uuid>" }`,
   newest first. Narrow with `"workflowId"` in `arguments` when the question is about one workflow;
   `"limit"` defaults to 10. Each row carries `status`, which is one of `Queued`, `Running`,
   `Passed`, `Failed`, `Cancelled`.
6. **Read one run in detail** — `GetWorkflowExecution` with `context: { "projectId": "<uuid>" }` and
   the run id in `arguments`: `{ "executionId": "<uuid>" }`. This is the call that answers "which
   step failed, and why" — per-step status, iteration, duration, tokens, cache reuse, whether it
   produced a video, its error, and a truncated preview of its output.

## Report

Give the workflow name, the run's status, the failing step, and the error text **verbatim**. Do not
turn an error string into a diagnosis the error does not support. `ListWorkflowExecutions` already
carries an `errorMessage` per run, so check there before drilling into the run. A previewed step
output is truncated — say so rather than implying you read all of it.

## Two things that surprise people

- **A refusal is a result, not a failure.** An authority refusal, a plan-gate refusal, a rate-limit
  refusal and an unknown workflow all come back as the tool's own JSON text with `isError: false`,
  because the text is meant to be read. Relay it. Retrying the identical call will not change it.
- **Stay read-only while investigating.** The tools above write nothing. Writing is a separate,
  explicitly confirmed flow — see the `author-workflow` skill.

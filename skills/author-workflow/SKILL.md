---
description: Author or change a ReelBolt workflow through the ReelBolt MCP tools - validate, propose, get the user's confirmation, apply, then execute. Use when asked to build, edit or run a ReelBolt workflow.
---

# Author and run a ReelBolt workflow

Build a workflow from a description, or edit an existing one, with the ReelBolt MCP tools. The
server is registered as `reelbolt`, so in this session its tools are named
`mcp__plugin_reelbolt_reelbolt__<ToolName>`.

Every call carries the page context in a single optional `context` argument — see the
`inspect-run` skill for its shape. Populate at least `context.projectId`.

## The tool set, in the order you use it

| Tool | Writes? | What it does |
|---|---|---|
| `ListAgents` | no | Agents available to this project (built-in plus the project owner's custom agents). This is where `agentDefinitionId` values come from. |
| `ListStepSchemas` | no | JSON Schema for every step type's configuration. **Call this before writing any step config** — the per-type config JSON is defined here, not guessed. |
| `ValidateWorkflow` | no | Validates proposed steps (agent ids exist and are owned, configs match their schema) and returns the errors. Nothing is written. |
| `ProposeWorkflow` | no | Computes a diff plus a `confirmationToken` for a proposed step set. Omit `workflowId` to propose a new workflow; supply it to propose an edit. Nothing is written. |
| `ApplyWorkflow` | **yes** | Applies a previously proposed change. Requires the exact `confirmationToken` that `ProposeWorkflow` returned for the same `workflowId`/`name`/`steps`. |
| `ExecuteWorkflow` | runs it | Executes an existing workflow. |

A step names an agent (`agentDefinitionId`, from `ListAgents`), carries a `stepOrder`, and may carry
a `label`; a step that is not a plain agent step additionally names its `stepType` and that type's
config. Rather than hand-writing that JSON, read an existing workflow with `GetWorkflow` — it returns
steps in exactly the shape `ValidateWorkflow` and `ProposeWorkflow` accept — and change what you
need. `ListStepSchemas` is where a step type's config schema comes from.

## Rules that are not optional

1. **Validate, then propose, then show the user, then apply.** `ApplyWorkflow` is the only tool here
   that writes. Never call it without first showing the user the diff `ProposeWorkflow` returned and
   getting an explicit yes.
2. **Never fabricate a `confirmationToken`.** The server recomputes and verifies it, so a made-up
   token is refused — the call comes back as a normal result carrying the tool's own
   `{"error":"stale confirmationToken, re-propose and try again"}` (`isError:false`), not an HTTP
   error. Do not treat that as a retry loop. If the token fails, re-run `ProposeWorkflow`; the
   payload changed under you.
3. **Never call `ExecuteWorkflow` from a step you have not read back.** After `ApplyWorkflow`,
   confirm with `GetWorkflow` (see `inspect-run`) that the stored steps are the ones you intended.
4. **Confirm style and format before running.** `ExecuteWorkflow` can take a saved style (`styleId`)
   or a built-in style preset (`stylePresetKey`) — never both — and an `outputFormat`. Ask the user
   which they want instead of choosing for them.
5. **Ask about paid video clips before running a workflow that has one.** If the workflow contains a
   `VideoGenerate` step, `ExecuteWorkflow` refuses to run until you pass
   `regenerateVideoClips`: `false` reuses previously generated clips for free, `true` regenerates
   them and costs money. Ask the user which, then pass their answer. With the flag omitted the tool
   returns a cost estimate for you to relay.
6. **`ExecuteWorkflow` is rate-limited** per user and project on a rolling hour. A refusal is a
   normal result, not a bug — tell the user rather than retrying.

## Reporting

Say what changed, in the user's terms: which steps were added, removed or edited, and the workflow
name. Relay any validation error text as it came back rather than summarising it into a cause.

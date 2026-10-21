# ReelBolt for Claude Code

Connect Claude Code to ReelBolt, so you can work with your ReelBolt projects, workflows and
pictures from your terminal instead of switching to the dashboard.

Sign-in happens in your browser. **There is no token to create, paste or store**, and nothing has to
be built or installed on your machine beyond the plugin itself.

## What it connects to

This plugin connects Claude Code to the ReelBolt platform assistant's MCP endpoint. It contains no
tool logic and no server: every ReelBolt tool has one implementation, on your ReelBolt deployment,
which also decides on every call whether you may use it.

| Where your ReelBolt runs | `server_url` |
|---|---|
| ReelBolt Cloud (<https://reelbolt.ai>) | `https://reelbolt.ai/mcp` |
| An installation you or your team runs | `https://<your-domain>/mcp` |

The address is always the one you sign in to, with `/mcp` on the end.

## Requirements

- **Claude Code**.
- **A ReelBolt account**. If you self-host, the address of your deployment.

That is all. There is no Node.js requirement, no build step, no API key and no signing key.

## Install

```bash
# 1. Add this repository as a plugin marketplace.
claude plugin marketplace add vecchiotom/reelbolt-claude-plugin

# 2. Install the plugin. `reelbolt@reelbolt` is <plugin>@<marketplace>.
claude plugin install reelbolt@reelbolt

# 3. Confirm it is installed.
claude plugin list
```

When Claude Code asks for the plugin's one option, `server_url`, enter the address from the table
above — `https://reelbolt.ai/mcp` for ReelBolt Cloud. To install non-interactively in a single
command:

```bash
claude plugin install reelbolt@reelbolt --config server_url=https://reelbolt.ai/mcp
```

Inside a session you can use `/plugin` instead of the shell commands: install `reelbolt@reelbolt`
from the marketplace you just added, then set its option under **Configure options**. To change the
option after installation:

```bash
echo '{"server_url":"https://reelbolt.ai/mcp"}' \
  | claude plugin configure reelbolt@reelbolt --values-stdin
```

Then start a session, or run `/reload-plugins`.

### Signing in

The first time Claude Code calls ReelBolt it:

1. Registers itself with your deployment automatically.
2. Opens your browser at ReelBolt, asking you to sign in if you are not already.
3. Shows a consent screen naming what is being asked for, and who is asking.
4. Stores the credential it is given and uses it from then on.

You approve once, in the browser. Nothing is copied by hand and no value is exported. If the
connection is later revoked, you connect again the same way.

`server_url` is required and deliberately has **no default**: a missing or wrong address fails
visibly rather than leaving the plugin pointing somewhere you did not choose.

### Working in the ReelBolt source repository

If you have a checkout of the ReelBolt source, the same plugin also installs directly from it:

```bash
claude plugin marketplace add ./plugins/reelbolt
claude plugin install reelbolt@reelbolt
```

and you can load it for one session without installing anything:

```bash
claude --plugin-dir ./plugins/reelbolt
```

## What Claude Code can do

Once connected, Claude Code gets the same tools as the ReelBolt assistant in the dashboard.
Broadly, it can:

- **Look things up** — your projects, a project's files and agents, its workflows, and the steps of
  one workflow.
- **Check on runs** — recent runs, and one run's per-step status, duration, credits and errors.
- **Draft and change workflows** — validate a set of steps, show you what a change would do, and
  apply it once you agree.
- **Make small edits and copies** — change one setting or rename a step of an existing workflow
  without resending it, copy a workflow into the same or another project, and set up a green-screen
  insert from a clip and the content to show on its screen (no AI model; only processing time is
  charged).
- **Start a run** — subject to the same hourly limit the dashboard assistant has. A run can take its
  brief from a text file in the project instead of a pasted request.
- **Work with the picture open in the picture editor** — read what it is made of, look at what it
  actually shows, and propose changes such as adding text, moving or deleting layers, changing the
  canvas, or running a paid picture tool.

Every change follows the dashboard's rule: Claude Code proposes it and shows you what would change,
and nothing is written until it is confirmed. Starting a run, deleting something, and anything that
costs money always come back to you first.

**Admin tools are off by default.** Thirteen of the assistant's tools manage the deployment's own AI
provider settings and require administrator rights. Unless they have been enabled for your account,
the catalog does not include them at all — they cannot be called by accident or by a cleverly worded
request. When they are enabled they are listed, and they still check your own permissions on every
call. Enabling them is a per-account setting that an administrator of your deployment sets; Claude
Code cannot turn it on for itself.

## What it costs

ReelBolt records every call Claude Code makes — what was asked for, whether it was allowed, and how
long it took — so usage is visible and unusual activity can be seen. A record is not a charge.

Credits are drawn only where the work itself costs ReelBolt money, exactly as in the dashboard:

- Looking around — projects, files, workflows, run history, a picture's layers — is free.
- **Starting a run** spends credits as the run's steps use paid services.
- **Paid picture tools** and designed graphics spend credits when applied; Claude Code is shown the
  estimated cost when it proposes one, so it can tell you before you agree.
- **AI-generated video clips** are the most expensive item, which is why Claude Code refuses to run
  a workflow containing them until you have chosen whether to reuse the clips from last time (free)
  or generate new ones (paid).

## Tool names, and the `context` argument

`/mcp` lists the server as `plugin:reelbolt:reelbolt`, and its tools are named
`mcp__plugin_reelbolt_reelbolt__<ToolName>` in permission rules and hook matchers.

The tool set is the platform assistant's, not one invented here, and `tools/list` from the server is
the source of truth rather than this README. The names this plugin's skills use:

`ListProjects`, `GetProject`, `ListProjectFiles`, `ListAgents`, `ListStepSchemas`, `ListWorkflows`,
`GetWorkflow`, `ListWorkflowExecutions`, `GetWorkflowExecution`, `ValidateWorkflow`,
`ProposeWorkflow`, `ApplyWorkflow`, `ExecuteWorkflow`.

Project-scoped tools take no `projectId` argument: they read the project from a single optional
`context` object (`projectId`, `workflowId`, `imageDocumentId`), which the MCP layer sends alongside
the tool's own arguments. See [`skills/inspect-run/SKILL.md`](./skills/inspect-run/SKILL.md).

## Skills

| Skill | Invoke with | What it does |
|---|---|---|
| `inspect-run` | `/reelbolt:inspect-run` | Reads a project's workflows and one run's status |
| `author-workflow` | `/reelbolt:author-workflow` | Validate → propose → confirm → apply → execute |

## Self-hosted deployments

Point `server_url` at your own deployment:

```
https://<your-domain>/mcp
```

The endpoint must be reachable over HTTPS and serve the MCP OAuth discovery documents on the same
origin:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`

A local development instance served on your own machine is `http://localhost/mcp`.

This plugin registers the remote HTTPS endpoint only. Running the MCP bridge as a local stdio
process is a separate setup that ships with the ReelBolt server, not with this plugin.

## Security notes

- **No secret is shipped anywhere in this repository.** There is no default or example key or
  token, and no `userConfig` option declares one.
- **Nothing installed on your machine can mint a ReelBolt credential.** The browser sign-in is the
  only way one is created, and it is issued by your deployment.
- **There is no fallback for `server_url`.** The plugin never guesses an address, so an unset
  option is a visible failure rather than a silent misdirection.
- **Never give this plugin, or a server you run for it, a platform signing key.** It never asks for
  one, and a signing key is the secret that mints tokens for every account.
- Read-only inspection and anything that writes are separate flows. The core write tool,
  `ApplyWorkflow`, requires the token a prior `ProposeWorkflow` returned.

## Troubleshooting

- **Claude Code says it needs to sign in.** Run the connection again; the browser step has to be
  completed by a person. Nothing connects silently.
- **Claude Code cannot see ReelBolt's tools.** Check that `server_url` ends in `/mcp` and that the
  session is signed in, then reconnect the server.
- **Calls are refused with a permissions message.** The tool exists but your account may not use
  it, or admin tools are not enabled for you. Refusals like this are answers, not crashes — they
  say what to do next.
- **A run is refused because of too many runs.** The dashboard assistant and Claude Code share an
  hourly limit per person per project. The message says how many you used and how long to wait.
- **The connection stopped after ReelBolt restarted.** Claude Code reconnects by itself; if it does
  not, reconnect the server.

## Where this comes from

This repository is the **published mirror** of ReelBolt's Claude Code plugin. The authoritative copy
lives in ReelBolt's source repository at `plugins/reelbolt/`; changes are made there and published
here. See [`PUBLISHING.md`](./PUBLISHING.md). Please do not send changes to this repository
directly — open an issue instead.

## License

MIT. See [`LICENSE`](./LICENSE).

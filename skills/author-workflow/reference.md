# Author a workflow: reference

All project-scoped tools accept an optional `projectId`; otherwise the project in `context` is used.

## Recipe tools

| Tool | Arguments | Notes |
|---|---|---|
| `ListWorkflowTemplates` | `goal?`, `projectId?` | Read-only. Per recipe: `title`, `tagline`, `category`, `forGoals`, `needs`, `costClass`, `briefFieldsRead`, `suggestedStylePreset`, steps. With a known project also `satisfied` and `missing`. `goal` sorts matches first and sets `matchesGoal`. |
| `GetWorkflowTemplate` | `templateKey` | Read-only. Ready-to-propose steps, `appManifest`, `briefBindings` (which steps read each brief field, and fields no step reads) and `availablePatches` (each closed patch and whether it fits). |
| `GetProjectReadiness` | `projectId?` | Read-only, free. Files by kind, design-system status, voices, AI capabilities the workspace has a provider for, plan limits, existing workflows and their recipe. |
| `EstimateWorkflowRun` | `workflowId` or `templateKey` (exactly one), `brief?`, `projectId?` | Read-only, free. Cost class (never a vendor price), usual credit range, what the workspace must have available to start, paid items, one-line `summary`. The estimate is of the plain recipe: patches are not priced. |
| `ProposeCreateFromTemplate` | `templateKey`, `brief?`, `patches?` (array of ids), `name?`, `projectId?` | Writes nothing. Returns `summary`, `workflowName`, `steps`, `costClass`, `confirmationToken`, `warnings`, `needsBeforeRunning` and `alreadyFromThisRecipe`. |
| `ApplyCreateFromTemplate` | the same, plus `confirmationToken` | Creates the workflow. The name is `name` if given, otherwise the recipe title, made unique. Starts no run. |

Closed patch ids, applied in this canonical order whatever order you list them: `swapToRoom`,
`addVoiceover`, `addCaptions`, `addMusic`, `addSfx`, `addColorGrade`, `addGraphics`. A patch is
refused, with a reason, when the recipe has no cut to edit, the feature is already on, the compile is
a stream copy, `addCaptions` has no narration, or the project has no audio files for `addMusic` /
`addSfx`.

### The brief

An object, every field optional, unknown fields refused: `language`, `sourceLanguage`, `lengthSec`
(5 to 600), `format` (`Original`, `Vertical`, `Square`, `Landscape`, `Portrait`), `resolution` (`Auto`,
`720p`, `1080p`, `2160p`), `stylePreset` or `styleId` (one of them), `tone` (`Calm`, `Upbeat`,
`Energetic`, `Serious`, `Playful`, `Inspirational`), `designSystem` (`project` or `none`),
`voice` (`{ "mode": "none" | "narrated", "projectVoiceId": "..." }`) and
`sourceFiles` (`[{ "role": "...", "fileIds": [...] }]`). The run card lists each set field and adds
"Not used by this app" for a field no step of the workflow reads. `ExecuteWorkflow` also takes
`briefFileId` (a text file of the same project, up to 64 KiB) as the brief.

### `needsBeforeRunning`

Errors about the project's state rather than the graph: a missing provider, voice, file, design
system, or a consent the customer gives in the app. They are reported by `ValidateWorkflow`,
`ProposeWorkflow` and `ProposeCreateFromTemplate` and do not make `valid` false or block the save.
Relay each one before offering to run.

## Custom graphs

| Tool | Writes? | Notes |
|---|---|---|
| `ListAgents` | no | Source of `agentDefinitionId`. |
| `ListStepSchemas` | no | JSON Schema for every step type's config. |
| `GetStepCatalog` | no | `stepType?`. Generated from code: purpose, cost class, needs and the lint rule that checks each, what it produces, brief fields read, pairings, common mistakes; one step type also returns its config schema. |
| `ValidateWorkflow` | no | Steps, optional `projectId` and `brief`. Returns `valid`, `errors`, `findings` (`ruleId`, `severity`, `stepOrder`, `message`, `fix`) and `needsBeforeRunning`. Warnings and notes are worth fixing or telling the user. |
| `ProposeWorkflow` / `ApplyWorkflow` | apply writes | Omit `workflowId` for a new workflow. Lint errors about the graph refuse the proposal with `code: WORKFLOW_LINT_ERRORS` and no token. |

`GetWorkflow` returns steps in exactly the shape these tools accept: copy and change it rather than
hand-writing JSON.

## Small edits and copies

- `ProposePatchWorkflow` / `ApplyPatchWorkflow`: `workflowId`, `operations` (up to 50). Each operation
  has `op`: `setStepConfig` (with `stepOrder` and `patch`, a JSON merge patch of that step's config;
  `null` deletes a key), `renameStep` (`stepOrder`, `label`) or `setStepField` (`stepOrder`, `field`
  from a fixed list of scalar fields, `value`). The proposal shows only the changed steps. Any change
  to the workflow since the proposal makes the token stale: re-propose.
- `ProposeCloneWorkflow` / `ApplyCloneWorkflow`: `workflowId`, optional `name`, optional
  `targetProjectId` (another project you can edit). A workflow that continues a composition or reads
  step results of its source project cannot move to another project.

## Running

`ExecuteWorkflow` arguments: `workflowId`, `brief?`, `userRequest?`, `briefFileId?`,
`regenerateVideoClips?`, `styleId?` / `stylePresetKey?` (one), `outputFormat?`, `outputResolution?`,
`projectId?`, `acceptEstimateCredits?`. It is rate-limited per user and project per rolling hour; a
refusal is a normal result, so tell the user rather than retrying. A resolution above the plan's limit
returns `planGate`. `acceptEstimateCredits` applies only to the "Build brand and product profile"
workflow over MCP: without it the tool refuses with `ESTIMATE_NOT_ACCEPTED` and the estimate; call
again with a figure at least as high as the estimate's high figure only after the user agrees.

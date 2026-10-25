---
description: The rules Claude must follow over the ReelBolt MCP - the footage-sharing consent belongs to the customer and is given in the app, never by Claude; Propose then Apply with a token; approval cards and auto mode; paid-clip questions; credit refusals; per-turn budgets; sign-in scope. Use before any write, any run, or when a call is refused for consent, credits or permission.
---

# Consent, approvals, budget and sign-in

## The consent Claude never gives

Some steps can send the customer's footage to an outside service. That permission is the flag
`allowSourceMediaEgress` on the step, and it is **the customer's own, given in the app** by opening
the step and switching on the option that allows sending their footage.

- Never set, pass, copy in, fake or guess it, in any workflow, patch or recipe config.
- The server enforces this: a proposal that turns it on is refused with the code
  `egress_consent_is_the_customers`. Relay that message and send the customer to the app. Do not
  rephrase the request to get around it.
- A consent that was already on is kept only when nothing else in the workflow changes (labels
  aside). Any other edit switches it off in the proposal and adds a `WL015` note that the customer
  must allow it again in the app. Relay that note.
- Linter finding `WL015` and `needsBeforeRunning` entries about consent are the customer's to clear.

## Propose, then Apply with the token

Every write is a `Propose*` tool (writes nothing; returns a diff or summary and a
`confirmationToken`) followed by the matching `Apply*` tool with the same arguments and the exact
token. Show the user the proposal and get an explicit yes first. Never invent a token. A stale token
is a normal result telling you to re-propose, not an error to retry in a loop.

## Approval cards and auto mode

In the dashboard chat, each `Apply*` tool and `ExecuteWorkflow` waits behind an approval card the
user clicks; "auto mode" skips the cards. **Over MCP (Claude Code) there is no card and no gate**:
the tool runs when you call it, so you are the user's only check. Do not rely on a card. The one
exception is `ApplyDecideDesignChange` with `decision: "approve"`, which the server always refuses
over MCP (see the `design-system` skill).

## Paid work

- `VideoGenerate` clips are paid. Before `ExecuteWorkflow` on a workflow that has one, ask the user
  whether to reuse earlier clips (free) or regenerate (paid), then pass `regenerateVideoClips`.
  With it omitted the tool refuses and returns a cost estimate.
- Price a run first with `EstimateWorkflowRun`; check `GetCreditBalance` before a large one.
- `INSUFFICIENT_CREDITS` comes back as a result with `message`, `missing` (credits still needed),
  `required` (the hold), `balance`, `low`, `high` and `typical`. Relay `message`; do not retry.

Read [`reference.md`](./reference.md) for the budget limits and sign-in details.

## Budget and sign-in in one line each

- The dashboard assistant stops a turn at 80 tool calls; Claude Code's own loop is not counted by
  that limit. Each assistant turn or MCP tool call also has a 100-credit ceiling on metered model
  usage. Both are deployment settings; see the reference.
- OAuth sign-in grants the scope `assistant.tools`; a refusal that says you may not use a tool is an
  answer. Admin tools are listed only if the account has them enabled.

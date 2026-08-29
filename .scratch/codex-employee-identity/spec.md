# Codex employee identity on agent cards

Status: resolved

## Problem

Codex reports native Observer employee agents with an `agentType` such as
`observer-marcus-reed`. The canvas ignores that explicit identity and only
scores the delegation text, so active employee agents can appear as unseated
task paths without a name, role, portrait, or ID card.

## Requirement

Resolve an exact Observer native employee-agent type to its roster profile
before attempting lexical task matching. Unknown and default agent types keep
their current matching and subcontractor behavior.

## Verification

- A captured Codex-style agent entity with `agentType: observer-marcus-reed`
  renders through the Marcus Reed roster profile and Engineering Manager role.
- Lexical seating, explicit subcontractors, and Observer activation nodes keep
  their current behavior.

## Outcome

The web selector now resolves exact `observer-<employee-id>` agent types to the
fixed roster before lexical seating. This restores the employee profile used by
the node, detail panel, portrait, role, and ID-card action.

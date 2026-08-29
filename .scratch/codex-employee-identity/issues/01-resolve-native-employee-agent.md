# 01 Resolve native employee-agent identity

Status: resolved
Type: task

## Requirement

Prefer the exact employee identity encoded in a host-native
`observer-<employee-id>` agent type over lexical seating.

## Definition of done

- The reported Codex case resolves to the correct roster employee.
- The canvas card receives the employee name, title, portrait, and ID-card action.
- Existing web tests and type checks pass.

## Answer

`selectEmployeeMatch` now recognizes host-native Observer employee-agent names
as authoritative identity. Exact roster matches bypass lexical scoring;
unknown prefixed types retain the previous task-matching fallback.

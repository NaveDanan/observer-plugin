# 11 Native employee agents without seats

Status: resolved
Type: task
Blocked by: 03, 04, 10
Owner seat: arjun-mehta

## Requirement

Expose every roster employee to every supported host without requiring a seat.
A seat may pin that employee's model, but must not force the host to delegate
to the employee.

## Definition of done

- OpenCode, Codex, Claude Code, and Copilot receive the full native employee roster.
- Unpinned employees omit model fields and inherit the host model choice.
- Seat control adds supported model options only to the configured employee.
- No hook or plugin controller rewrites a generic delegation into an employee delegation.
- Sync and uninstall preserve colliding files that Observer does not own.

## Answer

Implemented marker-owned native employee definitions for all four supported
hosts. Installation and config saves reconcile the complete roster. Turning
seat control on adds host-native model fields; turning it off removes those
fields while keeping employees available. The OpenCode and Copilot routing
controllers no longer select employees on the host's behalf.

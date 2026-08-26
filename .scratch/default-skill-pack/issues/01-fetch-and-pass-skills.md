# 01 Fetch and pass available skills

Status: needs-triage
Type: task

## Requirement

Use Codex `skills/list` for the current project, keep every enabled skill in
the returned merged inventory, list it in `observer config`, and pass it to
every Codex subagent while **Pass All Skills** is enabled.

## Definition of done

- Project and global skills are both retained.
- Disabled skills are not passed to employees.
- Pass All Skills is selected by default and can be turned off.
- Employee agents and subcontractors get identical pack metadata.
- Discovery failure does not prevent employee generation.
- Tests cover the request, parsing, failure behavior, and rendered agents.

## Answer

Implemented project-aware discovery, the Skills config screen, a private
per-project metadata cache, and pre-spawn injection for employee agents and
subcontractors. The config opt-out also removes the Default pack from generated
employee definitions. Typechecking and the full Vitest suite pass.

## Comments

- 2026-08-26: Resolved in the working tree. The hook remains fail-open when the
  cache or Codex discovery is unavailable.

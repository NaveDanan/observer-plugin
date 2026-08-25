# 01 Fetch and pass available skills

Status: ready-for-agent
Type: task

## Requirement

Use Codex `skills/list` for the current project, keep every enabled skill in
the returned merged inventory, and add the resulting Default pack to every
Observer-generated Codex employee.

## Definition of done

- Project and global skills are both retained.
- Disabled skills are not passed to employees.
- Every generated Codex employee gets identical pack metadata.
- Discovery failure does not prevent employee generation.
- Tests cover the request, parsing, failure behavior, and rendered agents.

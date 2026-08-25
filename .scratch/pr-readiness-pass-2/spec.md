# PR readiness, second pass

Status: ready-for-agent

Fix every actionable finding from the first review, then run a fresh complete-diff review against
the merge base with `origin/master`. Each issue is handled by one writer, one reviewer, and one
manager. Group members communicate directly through the host collaboration channel.

## Acceptance

- Every issue under `issues/` has a regression test or a documented reason no correct test seam exists.
- The writer's patch is accepted by the group's reviewer and manager.
- Repository typecheck, tests, production build, and `git diff --check` pass.
- A second-pass review of the complete merge diff reports no remaining actionable findings.

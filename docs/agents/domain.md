# Domain docs

## Before exploring

Read `CONTEXT-MAP.md` at the repository root, then read each context document relevant to the task. Read root `docs/adr/` for system-wide decisions and the relevant context-local `docs/adr/` directory for narrower decisions.

If those files do not exist, continue normally. The `domain-modeling` skill creates them when the project resolves terminology or an architectural decision.

## Context layout

This repository is multi-context. `CONTEXT-MAP.md` points to the documents under `apps/*/CONTEXT.md` and `packages/*/CONTEXT.md`. Each context may also have `docs/adr/` for decisions limited to that app or package.

## Vocabulary and ADRs

Use terms defined in the relevant context document when naming domain concepts. If a proposed change conflicts with an ADR, call out the conflict explicitly.

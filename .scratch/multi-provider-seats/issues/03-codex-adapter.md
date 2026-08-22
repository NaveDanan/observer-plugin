# 03 Codex adapter

Status: ready-for-agent
Type: task
Blocked by: 02
Owner seat: malik-johnson

Research: `docs/research/multi-provider/codex.html`

## Files owned

- `packages/cli/src/adapters/codex.ts` (new)
- `packages/cli/test/adapters/codex.test.ts` (new)

## Do

1. `profiles()` from Codex home resolution: `CODEX_HOME`, else `~/.codex`. Include the
   configured binary. One profile per home.
2. `catalogue()` by launching `codex app-server`, sending `initialize` then `initialized`,
   then paginating `model/list`. Bound it with a timeout. Cache per profile plus version.
   On any failure return an empty catalogue with a warning, never throw.
3. Map each model's supported reasoning efforts into a `reasoningEffort` select descriptor
   and service tiers into a separate `serviceTier` descriptor. Preserve unknown effort
   strings verbatim; do not coerce them into Observer's legacy variant list.
4. `diagnose()` accepts a bare slug. Reject only an empty model.
5. `capabilities()` returns `childModel: "experimental"`, `requiresReload: false`.
6. No `reconcile` yet. Ticket 09 covers the control prototype.

## Definition of done

- A missing `codex` binary yields an empty catalogue and a readable warning.
- Effort values come from the live model record, not a hard-coded list.
- Tests cover: missing binary, timeout, malformed JSON, pagination across two pages,
  unknown effort string preserved, empty model rejected.

## Do not

- Do not require `provider/model`.
- Do not mutate any hook or spawn path in this ticket.

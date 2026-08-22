# 07 Config TUI: host targets and dynamic options

Status: ready-for-agent
Type: task
Blocked by: 02
Owner seat: malik-johnson

Research: `docs/research/multi-provider/combined.html`, section "Config TUI flow"

## Files owned

- `packages/cli/src/config-ui-state.ts`
- `packages/cli/src/config-ui-render.ts`
- `packages/cli/src/config-ui.ts`
- `packages/cli/test/config-ui.test.ts`

## Do

1. Keep the existing split. All transitions stay pure in `-state`, all text stays pure in
   `-render`, all I/O stays in `config-ui.ts`. No view function reads `process.env`.
2. Add views: `targets` between `employee` and `models`, and `options` after `models`.
   Escape still unwinds exactly one level, and only the menu ends the session.
3. The employees list shows all roster rows. Derive it from `ROSTER`; never a second list.
4. Each target row shows host, profile, model, a short option summary, and its control
   status: applied, experimental, configured, or not applied to children.
5. Options render from adapter descriptors. Selects cycle with left/right, booleans toggle
   with enter. Changing the model re-derives descriptors and clears values the new model
   does not offer, reusing the existing clamp behaviour.
6. Catalogue loading is lazy, per selected target, so opening the TUI does not probe five
   CLIs.
7. Non-TTY report mode lists every configured target including unsupported ones.

## Definition of done

- A test asserts TUI employee ids equal `ROSTER.map(p => p.id)`, in order.
- No ANSI in output unless a theme is passed.
- Tests cover: navigation and unwinding, option clamping on model change, unsupported
  target rendering, empty catalogue free-text entry, and the report path.

## Do not

- Do not offer an effort control for a host whose adapter exposes none.
- Do not claim a target is in force when its adapter reports it unsupported.

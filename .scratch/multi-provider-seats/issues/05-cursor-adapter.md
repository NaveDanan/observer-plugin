# 05 Cursor adapter

Status: ready-for-agent
Type: task
Blocked by: 02
Owner seat: elias-mercer

Research: `docs/research/multi-provider/cursor.html`

## Files owned

- `packages/cli/src/adapters/cursor.ts` (new)
- `packages/cli/test/adapters/cursor.test.ts` (new)

## Do

1. `profiles()` from the configured binary (`cursor-agent`, or `agent` on newer installs)
   plus an optional API endpoint. Do not assume the two command names are interchangeable.
2. `catalogue()` by running `about --format json` for version and login state, then a
   scoped ACP session that requests `cursor/list_available_models`. Close the child process
   when the probe ends. Bound the whole thing with a timeout.
3. Translate each model's own `configOptions` into descriptors: `reasoning`,
   `contextWindow`, `fastMode`, `thinking`. Options are per model, not per provider.
4. Keep the model id bare. Strip a bracket suffix only for compatibility input; never
   store options inside the model string.
5. `capabilities()` returns `childModel: "unsupported"` and `childReasoning: "unsupported"`.
   The inspected implementation has no per-child setter and drops non-root sessions.

## Definition of done

- Probe failure, timeout or logged-out state each return an empty catalogue plus a warning.
- Selecting a different model re-derives that model's option set rather than reusing the
  previous one.
- Tests cover: missing binary, unsupported `--format`, logged out, grouped select options,
  boolean-as-select values, and option set changing after a model switch.

## Do not

- Do not copy t3code's preview date and channel gate as a permanent rule; report what the
  host advertises instead.
- Do not present root-session configuration as if it applied to a delegated child.

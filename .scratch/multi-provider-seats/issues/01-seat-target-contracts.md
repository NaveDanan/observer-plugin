# 01 Seat target contracts

Status: ready-for-agent
Type: task
Blocked by: none
Owner seat: malik-johnson

Everything else waits on this. It is the only ticket allowed to change the shared seat
schema, so it runs alone.

## Files owned

- `apps/daemon/src/seats.ts`
- `apps/daemon/src/providers.ts`
- `apps/daemon/test/seats.test.ts`

Touch nothing in `packages/protocol/`, `packages/cli/` or `apps/web/`. The working tree
already moved the model catalogue to `apps/daemon/src/models.ts` and added a
`providers` config plus `/v1/config`, `/v1/models` and `/v1/providers/status`. Read
`apps/daemon/src/config.ts` and `apps/daemon/src/providers.ts` before designing anything;
they already carry the provider-instance envelope this ticket builds on.

## Do

1. Define `HostKind = "codex" | "claude" | "cursor" | "grok" | "opencode"` in
   `providers.ts`, and extend `ProviderInstanceConfig` with the fields a profile needs:
   optional `binaryPath`, optional `homePath`. Keep the existing passthrough behaviour.
2. Define `SeatTarget { host, model?, options?: Array<{id, value: string | boolean}> }`
   and extend `SeatSpec` with `targets?: Record<string, SeatTarget>`.
3. Keep the existing permissive parsing: field-level `.catch()`, passthrough of unknown
   keys, unknown employee ids preserved.
4. Load legacy top-level `model`/`variant` as an implicit `opencode:default` target.
   Do not delete those fields on load. Only a save that writes `targets` removes them.
5. Move `malformed-model` (the `includes("/")` rule) out of `diagnoseSeats` into an
   OpenCode-owned validator signature that ticket 02 will implement. Shared diagnosis
   keeps: unknown employee, empty seat, control disabled, unknown field.
6. Add `SeatFinding` carrying `host` and `targetId` so a finding can name its target.

## Definition of done

- Existing `~/.observer/config.json` files load unchanged and diagnose identically.
- A bare `grok-build` model in a Grok target produces no `malformed-model` error.
- Round-trip save preserves unknown seat fields and unknown employee ids.
- `pnpm vitest run apps/daemon` passes.

## Do not

- Do not validate host-specific model syntax here.
- Do not import anything from `packages/cli`.
- Do not write observed state into a seat.

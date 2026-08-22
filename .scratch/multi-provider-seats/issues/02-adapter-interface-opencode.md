# 02 Host adapter interface and OpenCode extraction

Status: ready-for-agent
Type: task
Blocked by: 01
Owner seat: elias-mercer

Move today's OpenCode behaviour behind the first adapter without changing what it does.
This is a refactor. Any behaviour change is a bug in this ticket.

## Files owned

- `packages/cli/src/adapters/types.ts` (new)
- `packages/cli/src/adapters/index.ts` (new)
- `packages/cli/src/adapters/opencode.ts` (new)
- `packages/cli/src/models.ts`, `packages/cli/src/seat-agents.ts`
- their existing tests

## Interface

```ts
interface HostSeatAdapter {
  kind: HostKind
  label: string
  profiles(): HostProfile[]
  catalogue(profileId: string): ModelCatalogue
  diagnose(profileId: string, target: SeatTarget): SeatFinding[]
  capabilities(profileId: string): {
    discovery: "live" | "cached" | "manual"
    childModel: "supported" | "experimental" | "unsupported"
    childReasoning: "supported" | "experimental" | "unsupported"
    requiresReload: boolean
  }
  reconcile?(profileId: string, seats: SeatsConfig): ReconcileResult
}

interface ModelCatalogue {
  models: Array<{ id: string; label: string; contextWindow?: number; options: ModelOptionDescriptor[] }>
  source: string
  freshness: "live" | "cached" | "unknown"
  warnings: string[]
}
```

## Do

1. Create the interface and a registry keyed by `HostKind`.
2. Wrap the existing catalogue in `opencode.ts`: cache path, auth-key narrowing, the
   optional `opencode models --verbose` probe, the three-state variant logic. Keep the
   one-sided safety rule exactly as written.
3. Wrap `syncSeatAgents` as `reconcile`. Keep the marker, the `general`-only allow list,
   the `todowrite: deny` parity line, and the empty body.
4. Report OpenCode as `childModel: "supported"`, `requiresReload: true`.
5. Own the `provider/model` slash rule here, as `diagnose`.

## Definition of done

- `observer config` and `observer install opencode` behave exactly as before.
- Generated agent files are byte-identical for an unchanged config.
- `pnpm vitest run packages/cli` passes with the existing assertions intact.

## Do not

- Do not change the agent file format, generated names, or the neutral allow list.
- Do not add other hosts here.

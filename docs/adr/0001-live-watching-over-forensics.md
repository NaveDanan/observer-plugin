# Live-watching beats forensics

Observer's canvas was serving two jobs at once: watching subagents while they run, and reading back
what they did afterwards. Those jobs want opposite layouts, so the canvas was doing neither well —
the graph got squeezed under a three-column overview slab, while agent nodes displayed forensic
totals (message count, tool count) that answer nothing a watcher is asking.

We decided live-watching is primary. The canvas owns the full stage, agent nodes show current
activity and time-in-state instead of totals, and history stays reachable but stops competing for
space.

## Consequences

Nodes need the currently-running tool call, which lives in `AgentDetail` and is fetched per-agent on
demand. `SessionSnapshot` has to carry it instead, so this decision reaches into `packages/protocol`,
`packages/core` and `apps/daemon` — it is not a web-only change.

Elapsed time also means the canvas re-renders on a clock, which the store did not previously do: it
notified only when WebSocket changes arrived.

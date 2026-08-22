# 09 Codex child control prototype

Status: needs-info
Type: prototype
Blocked by: 03
Owner seat: malik-johnson, audited by daniel-brooks

Do not start until 03 lands and a real Codex spawn fixture has been captured. This is the
only ticket that changes what a host runs, so it stays gated.

## Open question this ticket must answer first

What is the exact `tool_input` shape Codex passes to `PreToolUse` for its native child
spawn tool, on the installed version? Nothing in either repository proves it. Capture a
real payload before writing any rewrite logic.

## Why the obvious routes are wrong

- `SubagentStart` fires after the child exists. It cannot choose a model.
- The current hook emitter writes nothing to stdout and always exits 0, by design, so it
  can never return a control response. A control path needs its own executable.

## Shape

1. A separate synchronous Codex control binary, installed alongside the emitter, handling
   `PreToolUse` only.
2. It validates the tool name and the full input object, changes only model and reasoning
   effort, and returns Codex's `updatedInput` with every other field copied verbatim.
3. Every uncertainty returns no mutation: unknown tool, unexpected shape, unknown employee,
   unmatched seat, missing target, host timeout, daemon unreachable.

## Definition of done

- A captured real payload is committed as a fixture.
- Tests cover: neutral spawn rewritten, specialised spawn untouched, malformed input
  untouched, timeout untouched, unknown model untouched.
- Losing the model preference never loses the delegation.
- `capabilities()` flips to `childModel: "supported"` only after these pass.

## Do not

- Do not reuse the telemetry emitter for control.
- Do not rewrite a spawn that names a specialised agent.

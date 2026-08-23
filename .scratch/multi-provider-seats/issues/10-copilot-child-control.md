# 10 Copilot child control

Status: resolved
Type: task
Blocked by: 03, 07
Owner seat: malik-johnson

## Requirement

When Copilot delegates neutral work and Observer seats an employee with a
`copilot` target, the child must run through an Observer-generated agent using
that target's model, effort level, and context tier.

## Constraints

- Rewrite only `task` calls whose `agent_type` is `general-purpose`.
- Preserve the complete original task argument object.
- Keep telemetry and control in separate executables.
- Every uncertainty must fail open with `{}` and exit zero.
- Reconcile only Observer-owned plugin agents and settings keys.
- Do not claim Copilot cloud-agent support.

## Definition of done

- Generated plugin agents carry the selected employee and model.
- Observer-owned `subagents.agents` settings are reconciled without touching
  unrelated settings.
- The plugin runs the controller before its telemetry hook.
- Unit tests cover rewrite, specialised-agent preservation, malformed input,
  missing targets, disabled control, and settings preservation.
- The real installed plugin contains the generated agents and controller.

## Answer

Implemented local Copilot seat control with generated plugin agents, qualified
plugin agent ids, per-agent model/effort/context settings, and a synchronous
fail-open `preToolUse` controller. The controller accepts Copilot's serialized
task arguments, preserves every field except a neutral `agent_type`, and leaves
specialists untouched.

End-to-end validation on Copilot CLI 1.0.80 routed a neutral delegation from
`gpt-5.6-sol` to `observer:observer-malik-johnson`; Copilot reported the child
running `gpt-5-mini` and completing successfully.

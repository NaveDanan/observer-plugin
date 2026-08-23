# Copilot delegated-subagent control

Research date: 2026-08-23

## Finding

GitHub Copilot CLI exposes the pieces needed for an Observer seat controller:

- `preToolUse` runs before the `task` tool and may replace the complete argument
  object with `modifiedArgs`.
- Plugins can contribute custom agents from `agents/*.agent.md`.
- Custom agents have a documented `model` field.
- `settings.json` supports per-agent `model`, `effortLevel`, and `contextTier`
  under `subagents.agents.<agent-name>`.

This supports a deterministic design: generate one namespaced agent per
employee, then rewrite only a neutral `task(agent_type="general-purpose")`
delegation to the matched employee agent. Preserve every other task argument.

The local CLI path was exercised end to end against Copilot CLI 1.0.80: a
neutral `general-purpose` call from `gpt-5.6-sol` was rewritten to
`observer:observer-malik-johnson`, and `subagent.started`,
`subagent.completed`, and task telemetry all reported the configured
`gpt-5-mini` child model. The same local plugin cache is consumed by the
Copilot app.

## Verified host surface

- The camel-case `preToolUse` payload contains `toolName` and `toolArgs`. Its
  output accepts `modifiedArgs`, which replaces the tool arguments. The
  documented `toolArgs` type is `unknown`; Copilot CLI 1.0.80 was observed
  serializing `task` arguments as a JSON string, so the controller accepts both
  that runtime shape and an already-parsed object.
  [Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference#pretooluse--pretooluse)
- A command hook error or non-zero exit denies the tool call; a timeout is
  fail-open. A controller must therefore catch every error, print valid `{}`,
  and exit zero.
  [Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference#pretooluse--pretooluse)
- Plugins can carry custom agents in `agents/`, hooks, skills, and MCP servers.
  Plugin contents are cached when installed.
  [Plugin overview](https://docs.github.com/en/copilot/concepts/agents/about-plugins)
  and [CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- A custom agent's documented frontmatter includes `model` and `tools`.
  [Custom-agent configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration)
- Per-agent runtime settings are stored in user `settings.json`, not the
  credential-bearing internal `config.json`. The supported fields are `model`,
  `effortLevel`, and `contextTier`.
  [CLI configuration directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference#configuration-file-settings)
- Copilot CLI 1.0.24 fixed `preToolUse` handling of `modifiedArgs`; later releases
  fixed plugin-agent dispatch through `task(agent_type=...)`.
  [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)

## Safe implementation

1. Generate `observer-<employee>.agent.md` files with the configured Copilot
   model and the employee briefing. Copilot exposes installed plugin agents to
   the task tool as `<plugin>:<agent>`, so Observer routes to
   `observer:observer-<employee>`.
2. Reconcile only Observer-owned
   `subagents.agents.observer:observer-<employee>` entries in `settings.json`.
3. On `preToolUse`, accept only an object payload for `toolName === "task"`.
4. Match the task prompt to an employee and rewrite only
   `agent_type === "general-purpose"`.
5. Copy the full original argument object and change only `agent_type`.
6. Require both a marker-owned generated file and an exact matching
   model/effort/context entry in Copilot settings.
7. Return `{}` for disabled control, malformed input, a specialised agent,
   an unmatched task, stale or missing generated state, or any internal error.

`subagentStart` is not a control point: it fires after the child is selected and
can add context only. The telemetry emitter must also remain separate because
its contract is deliberately “never write a hook decision.”

## App scope

The local Copilot app uses the same runtime session and plugin cache as Copilot
CLI, so the installed-plugin path is testable there. GitHub's cloud agent is
different: its sandbox does not receive user-level hooks, settings, or locally
installed plugins. Cloud-agent support would require a repository-installed
plugin and separate validation.

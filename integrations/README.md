# Integrations

`observer install <host>` writes the configuration below for you and
`observer uninstall <host>` removes it again. This page documents what it
writes, for teams that prefer to manage host configuration by hand.

In every case `NODE` is the absolute path to your Node binary and `EMIT` is the
absolute path to `packages/hook-emitter/dist/emit.js`. Run
`observer where` to print both.

---

## OpenCode

**Installed to:** `~/.config/opencode/plugins/observer.js`
(honours `XDG_CONFIG_HOME`)

A copy of [`opencode/observer-plugin.js`](./opencode/observer-plugin.js).

This is the only host where Observer runs in-process rather than through a hook
subprocess, which is why it has the highest fidelity:

- It resolves each child session back to its root, so OpenCode's child-session
  subagents become nodes in one graph.
- It labels message parts with their role, so user text is never misfiled as
  assistant output.
- It coalesces token deltas and batches deliveries, so a fast stream costs a few
  requests per second rather than one per token.
- It reads the composed system prompt through
  `experimental.chat.system.transform` **without modifying it**.

The plugin stays dormant if `~/.observer/config.json` does not exist.

---

## Claude Code

**Installed to:** `~/.claude/settings.json`, merged into the `hooks` key.

Uses exec form (`command` + `args`), so paths containing spaces need no quoting:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "NODE",
            "args": ["EMIT", "--host", "claude", "--event", "SessionStart"],
            "timeout": 5,
            "statusMessage": "Observer"
          }
        ]
      }
    ]
  }
}
```

Subscribed events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
`UserPromptExpansion`, `MessageDisplay`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`,
`InstructionsLoaded`.

`MessageDisplay` runs on the render path, which is why the emitter does nothing
except forward the payload and exit.

---

## Codex

Codex offers two integration modes. Pick **one** — running both records every
event twice, and `observer install` warns you if you do.

### Mode A: plugin (recommended for the ChatGPT desktop app)

```bash
observer install codex --plugin
```

This packages Observer as a real Codex plugin and registers it in your personal
marketplace, so it shows up in the ChatGPT desktop app's Plugins directory.

It writes:

```text
~/.codex/plugins/observer/
  .codex-plugin/plugin.json      manifest
  hooks/hooks.json               lifecycle hooks
  scripts/emit.js                the emitter, shipped inside the plugin
~/.agents/plugins/marketplace.json   personal marketplace entry
```

Then, in the ChatGPT desktop app: **restart it**, open the Plugins directory,
select the `observer-local` marketplace and install Observer. From a terminal
the equivalent is:

```bash
codex plugin add observer@observer-local
```

Finally run `/hooks` inside Codex and trust the Observer entries. Plugin hooks
are non-managed, so Codex skips them until reviewed.

Two details make this work:

- `~/.agents/plugins/marketplace.json` is **auto-discovered**; no
  `codex plugin marketplace add` is required. Its paths resolve relative to your
  home directory, which is why the entry reads `./.codex/plugins/observer`.
- Hook commands reference `"$PLUGIN_ROOT/scripts/emit.js"`. Codex copies the
  plugin into `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` and
  points `PLUGIN_ROOT` at that copy, so the emitter must travel with the plugin
  rather than being referenced by absolute path.

To remove it:

```bash
observer uninstall codex --plugin
codex plugin remove observer@observer-local     # drops Codex's cached copy
```

### Mode B: direct hooks

**Installed to:** `~/.codex/hooks.json` (honours `CODEX_HOME`)

```bash
observer install codex
```

Codex hooks take a single shell string, so paths are shell-quoted:

```json
{
  "description": "Observer agent telemetry",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "NODE EMIT --host codex --event SessionStart",
            "timeout": 5,
            "statusMessage": "Observer"
          }
        ]
      }
    ]
  }
}
```

### Both modes

Subscribed events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`,
`SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`, `PreCompact`,
`PostCompact`.

**Codex requires explicit trust for new hooks.** Run `/hooks` inside Codex and
approve the Observer entries, otherwise they are listed but skipped. If hooks
were disabled, set `[features] hooks = true` in `~/.codex/config.toml`.

---

## GitHub Copilot CLI

Copilot offers two integration modes. Pick **one** — running both records every
event twice, and `observer install` warns you if you do.

### Mode A: plugin (recommended)

```bash
observer install copilot --plugin
```

This packages Observer as a real Copilot plugin, so it shows up in
`copilot plugin list` and in the GitHub Copilot desktop app's installed plugins.

It writes:

```text
~/.copilot/plugins/observer/
  plugin.json            manifest, points at hooks/hooks.json
  hooks/hooks.json       lifecycle hooks
  agents/*.agent.md      generated employee agents
  scripts/emit.js        telemetry emitter
  scripts/copilot-control.js  synchronous task controller
```

then runs `copilot plugin install ~/.copilot/plugins/observer`, which is what
actually registers it. Copilot copies the staged directory to
`~/.copilot/installed-plugins/_direct/observer/` and records it in
`~/.copilot/config.json`; copying files there by hand does not work.

Restart Copilot CLI (and the desktop app) so the new session picks it up.

Unlike the Codex plugin, the hook commands use **absolute paths** to `node` and
the installed emitter rather than `$PLUGIN_ROOT`. Copilot documents
`${PLUGIN_ROOT}` for LSP configuration but makes no such promise for hook
command strings, so the plugin uses paths that are known to resolve.
`scripts/emit.js` still ships inside the plugin for provenance.

With `seats.control: true`, the plugin's controller redirects only a
`general-purpose` task to the selected employee agent. The agent supplies the
configured Copilot model; Observer-owned `observer:observer-*` entries under
`~/.copilot/settings.json` supply subagent effort and context tier. All other
task arguments and all specialist agent selections are preserved. Controller
errors emit an empty decision and exit successfully, so a failure leaves the
delegation unchanged instead of blocking it. Restart Copilot after changing a
seat because agents and subagent settings load at startup. This control path
affects the local CLI/app only.

To remove it:

```bash
observer uninstall copilot --plugin
```

### Mode B: direct hooks

**Installed to:** `~/.copilot/hooks/observer.json` (honours `COPILOT_HOME`)

```bash
observer install copilot
```

Observer owns this file entirely, and ships both shells so the same
configuration works on Windows:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "NODE EMIT --host copilot --event preToolUse",
        "powershell": "& \"NODE\" \"EMIT\" --host copilot --event preToolUse",
        "timeoutSec": 5
      }
    ]
  }
}
```

Subscribed events: `sessionStart`, `sessionEnd`, `userPromptSubmitted`,
`preToolUse`, `postToolUse`, `postToolUseFailure`, `agentStop`, `subagentStart`,
`subagentStop`, `errorOccurred`.

Both modes subscribe to the same events — the plugin generates its hook list
from the same table the direct install uses, so the two cannot drift.

Because no Copilot hook carries the main agent's reply text, the daemon also
tails `~/.copilot/session-state/<id>/events.jsonl` for sessions it already knows
about, and marks anything found there as `reconciled`.

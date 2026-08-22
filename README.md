# Observer

An interactive canvas for the coding agents you are already running.

Observer shows every agent in a session as a node, draws the connections
between them, and lets you open any node to see what that agent was told, what
it is saying right now, and what it still has to do.

Supported hosts: **OpenCode**, **Codex**, **Claude Code**, **GitHub Copilot CLI**.

---

## What you get

- **A live agent graph.** Parent and child agents, with edges showing who
  delegated to whom.
- **A company roster on every node.** Observer seats each agent as an employee
  from a fixed cast of 14 profiles — the matcher reads the task text and picks
  the best fit (the SRE for deployment trouble, QA for flaky tests, security
  for threat models). Nodes show the employee's photo, name, tone and top
  strengths; clicking a node opens a panel on the right with their profile,
  the chat transcript (tool calls interleaved), the prompt and todos.
- **Guidance back to the model.** The OpenCode plugin offers the roster to the
  root agent as subagent staffing: who is on the team, what each employee is
  strong at, and when to reach for them. When a subagent is spawned it appends
  a persona directive — name, tone, strengths — and records the seated
  employee as the node's type; a subagent run without an employee is typed
  `subcontractor` (`"guidance": false` in `~/.observer/config.json` turns this
  off). Typing **`@observer`** in a message activates staffing for that
  session on demand — even with guidance off — and `@observer off` disables it
  again, even with guidance on. Observer installs a small agent definition next
  to the plugin, so `@observer` appears in OpenCode's `@` menu; selecting it
  inserts the mention, which is what activates staffing.
- **Per-node model attribution.** Each node names the model it is running, and
  says so plainly when the host never reported one.
- **Seat control, if you ask for it.** Off by default; see below.
- **Session goal and todos on the canvas** so the overall objective stays
  visible while subagents come and go.
- **Honest fidelity.** Every host exposes different data. Observer labels each
  connection and prompt as `authoritative`, `reconciled` or `inferred`, and
  never invents the parts a host does not expose — including employee seating:
  no lexical match, no persona.

---

## Install

Requires **Node 22.5+** (Observer uses the built-in `node:sqlite`, so there is
no native build step).

### From a release tarball

This is how you install Observer on a machine that does not have the source.

```bash
npm install -g observer-ai-0.1.0.tgz

observer install all      # or: observer install claude codex
observer start
observer open
```

Restart any running agent session so the host picks up the new hooks. Codex
additionally requires you to approve new hooks with `/hooks` inside Codex.

### Install into the ChatGPT desktop app (Codex plugin)

To have Observer appear in the ChatGPT desktop app's Plugins directory instead
of editing `~/.codex/hooks.json`:

```bash
observer install codex --plugin
```

Then restart the ChatGPT desktop app, install **Observer** from the Plugins
directory (marketplace `observer-local`), and run `/hooks` inside Codex to trust
it. The terminal equivalent of the install step is
`codex plugin add observer@observer-local`.

Use either this or `observer install codex`, not both — the CLI warns you if you
do, because each event would be recorded twice. See
[docs/integrations.md](integrations/README.md).

Check everything at once:

```bash
observer doctor
```

### From source

```bash
pnpm install
pnpm build
node packages/cli/dist/cli.js install all
node packages/cli/dist/cli.js start
```

### Building a release

```bash
pnpm release     # -> release/observer-ai-<version>.tgz
```

The tarball bundles every first-party package into three executables plus the
built UI, so the target machine only downloads Fastify from npm. See
[docs/release.md](docs/release.md).

### Uninstall

```bash
observer uninstall all
npm uninstall -g observer-ai
rm -rf ~/.observer
```

---

## Seat control

By default Observer only watches. Seating an employee on a node labels it and
briefs the subagent; it does not change which model the host runs. **Seat
control** is the opt-in flag that changes that.

In `~/.observer/config.json`:

```jsonc
{
  "seats": {
    "control": true,
    "employees": {
      "arjun-mehta": { "model": "anthropic/claude-opus-4-5", "variant": "high" },
      "dr-mei-lin":  { "model": "openai/gpt-5", "skills": ["forecasting"] }
    }
  }
}
```

Run `observer install opencode` after editing, then **restart OpenCode**.

### What it actually does

OpenCode's task tool takes no model parameter. The only lever is
`subagent_type`, so `observer install opencode` writes one hidden agent
definition per configured employee into `~/.config/opencode/agent/observer-*.md`,
and the plugin points a seated delegation at it. That is the whole mechanism.

The generated definition keeps the built-in `general` prompt and work
permissions: empty prompt, `mode: subagent`, and `todowrite: deny`. The plugin
registers Observer's nested-spawn, identity and direct-message tools. To prevent
OpenCode from stripping nested task access, it adds `task: allow` only to
`general` and generated Observer seats when no global, wildcard or per-agent
task policy exists. Each tool also checks the host's resolved session policy,
and nested children inherit the parent's restrictions. Observer changes
OpenCode's otherwise non-nesting depth default to 8 while preserving an
explicit user value.

### What you should expect to change

- **Permission prompts name a different agent.** The task tool asks for
  permission using the agent name it was handed, so a seated delegation now
  prompts for `observer-arjun-mehta` instead of `general`. This is the most
  visible effect and the main reason the flag defaults off.
- **Billing.** Delegations run on the model you named, not the session's.

### What it will not do

- **It only ever replaces a `general` delegation.** `subagent_type` does not
  name a model, it names a whole agent definition — prompt, permissions,
  everything. `general` is the only built-in that ships with no prompt and no
  restriction, which is what makes swapping it lossless: the model changes and
  nothing else. If the model delegates to `explore` — which carries a
  specialised prompt *and* a deny-by-default permission set that allows only
  reads and searches — or to any other built-in, or to an agent you wrote
  yourself, Observer leaves it alone. You keep that agent's behaviour and its
  restrictions; you lose the model preference for that one task. Trading a
  read-only guarantee for a model preference, silently, is not a trade Observer
  will make on your behalf.
- **It skips a reasoning effort your model does not offer.** OpenCode checks
  `variant` against the model when the delegation runs, not when the file
  loads, so `"variant": "xhigh"` on a model offering only low/medium/high would
  write a perfectly valid file and then fail the task. Observer checks it
  against OpenCode's own model catalogue first and writes no file at all,
  telling you which efforts that model does offer. When the catalogue is
  missing, or has never heard of your model, the file is written as before — an
  unknown model is not a wrong model.
- **Nothing happens without a restart.** OpenCode reads agent definitions once
  at startup and never rescans, so files written by the installer are invisible
  to a session that was already running.
- **A missing definition is a no-op, never an error.** If the agent the plugin
  wants is not in the host's registry — config edited without re-running the
  installer, agent directory cleaned out, config carried to another machine by
  dotfiles — the plugin leaves `subagent_type` exactly as it found it. You lose
  the model preference for that task; you do not lose the task.
- **A reasoning effort with no model does nothing.** OpenCode applies a
  `variant` only to an agent's own configured model, so `{"variant": "high"}`
  alone is inert. `observer doctor` and the installer say so rather than
  pretending otherwise.
- **`control: false` really is off.** Turning it off deletes every generated
  definition rather than merely ignoring it, so you cannot keep paying for a
  model you stopped asking for.

### Only OpenCode

| | OpenCode | Codex | Claude Code | Copilot CLI |
| --- | --- | --- | --- | --- |
| Seat `model` | applied to `general` delegations, with `control` on | **ignored** | **ignored** | **ignored** |
| Seat `variant` (effort) | applied, needs a model the effort exists on | **ignored** | **ignored** | **ignored** |
| Seat `skills` | applied | applied | applied | applied |

The other three hosts integrate through a subprocess hook that fires *after* a
subagent has been created. There is no point at which Observer could name a
model, so it does not offer to. Setting `model` or `variant` for an employee
you only ever run under Codex or Claude Code changes nothing at all, and
Observer would rather say that than imply a setting works everywhere.

Skills are the exception, and are not gated on `control`: they are prompt text
folded into the persona directive the daemon already returns, so they carry
none of the risk of pointing a host at an agent that does not exist.

### Removing it

`observer uninstall opencode` deletes the generated definitions along with the
plugin. Files in that directory that Observer did not write are left alone —
ownership is proved by a marker line inside the file, so deleting that line is
how you adopt a generated definition as your own.

---

## How it works

```text
host hook / plugin
  -> observer-emit           (tiny, dependency-free, always exits 0)
  -> daemon /v1/hook         (adapter normalises host vocabulary)
  -> SQLite event log        (append-only, idempotent)
  -> reducer                 (projects sessions, agents, edges, messages, todos)
  -> WebSocket               (live changes)
  -> React canvas
```

Two rules shape the whole design:

1. **Never disturb the agent.** The hook process exits 0 with empty stdout no
   matter what happens, so Observer cannot block a tool call or be mistaken for
   a hook decision. If the daemon is down, deliveries spool to disk and replay
   on the next start. Seat control is the single opt-in exception, and it is
   built to fail towards this rule: when it cannot confirm the agent it wants
   exists, it changes nothing.
2. **Never claim data you do not have.** Adapters translate; they do not guess.
   Anything reconstructed is marked as such and rendered differently.

### Packages

| Path                     | Purpose                                                  |
| ------------------------ | -------------------------------------------------------- |
| `packages/protocol`      | Event schemas, entities, per-host capability declarations |
| `packages/roster`        | Employee profiles, task→employee matcher, persona directives |
| `packages/core`          | Reducer, status normalisation, secret redaction           |
| `packages/storage`       | SQLite migrations, event log, entity projection           |
| `packages/adapters`      | One translator per host                                   |
| `packages/hook-emitter`  | The `observer-emit` binary hooks execute                  |
| `packages/cli`           | `observer` command: install, start, doctor                |
| `apps/daemon`            | REST + WebSocket API, spool recovery, Copilot log tailer  |
| `apps/web`               | React canvas                                              |
| `integrations/opencode`  | The OpenCode plugin, installed into your config directory |

---

## Host fidelity

Observer is only as good as what each host exposes. The UI shows this table
per session; it is reproduced here so you know what to expect before installing.

| | OpenCode | Codex | Claude Code | Copilot CLI |
| --- | --- | --- | --- | --- |
| Live reply text | token stream | end of turn | line batches | via session log |
| Agent graph | authoritative | reconciled | reconciled | reconciled |
| Todos | authoritative | from `update_plan` | from `TodoWrite` | from `update_todo` |
| Model per agent | authoritative | authoritative | partial | partial |
| System prompt | partial | config only | config only | none |

Notable gaps, stated plainly:

- **Claude Code** reports the main model only at session start, so a later
  `/model` switch is not observed. `SubagentStart` carries no parent id, so the
  edge is recovered from the `Agent` tool result and marked `reconciled`.
- **Copilot CLI** fires no hook containing the main agent's reply. Observer
  tails `~/.copilot/session-state/<id>/events.jsonl` to recover it. Its
  `preToolUse` hook has no call id, so repeated identical calls merge into one
  row.
- **Codex** exposes the active model on every hook payload, but no assistant
  deltas: replies appear when the turn ends.
- **No host** exposes its complete composed system prompt. Observer shows the
  parts that are available (agent definitions, instruction files, delegated
  task prompts) and labels the rest `unavailable`.

---

## Opening the canvas

Observer stays **connected to the harness that opened it**. There is no harness
picker in the UI: run `observer open` from inside the harness you are working
in, and the canvas binds to it.

```bash
observer open                 # binds to the harness that launched it
observer open --host codex    # bind explicitly
observer open --all           # show every harness
```

Detection walks the **parent process chain** first and takes the nearest
harness it finds. This matters because harnesses nest: a Claude Code session
started from an OpenCode terminal inherits `OPENCODE=1`, so the environment
alone would bind to the wrong one. Only the process tree says which harness is
innermost.

Environment markers (`OPENCODE`, `CLAUDECODE`, `CODEX_SESSION_ID`,
`COPILOT_SESSION_ID`, …) are the fallback for Windows and detached processes.
Configuration overrides such as `CODEX_HOME` are deliberately ignored — people
export those in shell profiles, and they say nothing about who launched the
command. When nothing is detected, Observer shows every session rather than
guessing.

The binding is carried in the URL (`?host=codex`), so it survives a reload and
can be bookmarked per harness.

## Troubleshooting

**The canvas is empty while agents are clearly running.**

There are only two causes, and Observer tells you which:

```bash
observer doctor
```

The **Delivery health** section counts every delivery that arrived but did not
become an event:

| Reason      | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `unmapped`  | The host sent an event Observer does not translate yet          |
| `malformed` | The hook payload was not valid JSON when it reached the emitter |
| `invalid`   | An adapter produced something that failed schema validation     |
| `ignored`   | Recognised by the adapter, deliberately not drawn on the canvas |
| `filtered`  | Removed on purpose by your capture settings                     |
| `duplicate` | Already recorded; expected while replaying the spool            |

Only the first three are faults. Each is listed with the host, the event name
and the payload's **key names** — enough to spot a missing `session_id` without
Observer ever storing your prompts:

```text
codex     SessionStart          unmapped   keys: model, cwd
claude    MessageDisplay        malformed  keys: text
      Bad control character in string literal in JSON at position 63
```

The UI shows the same thing as a banner, so an empty canvas is never silent.

If `accepted` is `0` and there are no faults either, nothing is reaching the
daemon at all: check that the host was restarted after `observer install`, and
for Codex that you trusted the hooks with `/hooks`.

## Privacy

Everything stays on your machine. See [docs/privacy.md](docs/privacy.md) for the
full detail; the short version:

- The daemon binds to `127.0.0.1`, validates the `Host` header, and requires a
  bearer token.
- Data lives in `~/.observer` (mode `0700`) and nothing is ever uploaded.
- Secrets are redacted **before** the database write, not at display time.
- Raw reasoning capture is **off** by default.
- Sessions older than the retention window (30 days) are pruned automatically,
  and any session can be deleted from the UI.

---

## Development

```bash
pnpm build          # everything, including the UI
pnpm test           # builds libraries, then runs the suite
pnpm typecheck
pnpm dev            # daemon with reload; run `pnpm --filter @observer-ai/web dev` beside it
```

The Vite dev server proxies `/v1` to the daemon on port 4599.

## License

MIT

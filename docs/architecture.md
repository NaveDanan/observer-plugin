# Architecture

## Data flow

```text
┌──────────────────────┐
│ host                 │  OpenCode plugin, or a hook running observer-emit
└──────────┬───────────┘
           │  POST /v1/hook   (raw host payload, unmodified)
┌──────────▼───────────┐
│ adapter              │  one per host: translates host vocabulary
└──────────┬───────────┘
           │  IngestEvent[]
┌──────────▼───────────┐
│ capture policy       │  drops disabled categories
│ redaction            │  removes secrets, caps size
└──────────┬───────────┘
┌──────────▼───────────┐
│ event log (SQLite)   │  append-only, unique on event id
└──────────┬───────────┘
┌──────────▼───────────┐
│ reducer              │  projects sessions, agents, edges, messages, todos
└──────────┬───────────┘
           │  Change[]
┌──────────▼───────────┐
│ broadcaster          │  WebSocket fan-out + bounded replay buffer
└──────────┬───────────┘
┌──────────▼───────────┐
│ React canvas         │
└──────────────────────┘
```

Normalisation happens in the **daemon**, not in the hook process. A mapping bug
can therefore be fixed by restarting the daemon, without users reinstalling
hooks into four different hosts.

## Why the hook process is so small

`observer-emit` runs on every tool call of every agent. It therefore:

- has zero dependencies, so process start stays cheap;
- writes nothing to stdout, so no host can read it as a hook decision;
- always exits 0, so it can never block or fail a tool call;
- gives up after 1.5 s and spools to disk instead of waiting.

## Making silence visible

Those same rules mean every failure is swallowed. A malformed payload, an
unrecognised event, or content removed by capture settings all end identically:
nothing appears on the canvas, which is indistinguishable from an idle agent.

`Diagnostics` closes that gap. Every discard path reports a reason:

| Reason      | Fault? | Cause                                          |
| ----------- | ------ | ---------------------------------------------- |
| `unmapped`  | yes    | No adapter produced events for the delivery    |
| `malformed` | yes    | The emitter could not parse the payload        |
| `invalid`   | yes    | Adapter output failed schema validation        |
| `ignored`   | no     | The adapter recognised it and drew nothing     |
| `filtered`  | no     | Capture settings removed it deliberately       |
| `duplicate` | no     | Already stored, expected during spool replay   |

The difference between `unmapped` and `ignored` is the one that matters: an
adapter declares the deliveries it knowingly discards (`Adapter.ignores`) from
an allowlist, so OpenCode's `step-start` parts stay quiet while a part type
nobody has taught Observer about still raises a fault.

Counters and the last 100 fault samples are exposed at `/v1/diagnostics`, with
`faults` summarised on `/health`. Samples keep the payload's **top-level key
names only** — never values — so a missing `session_id` is diagnosable without
retaining prompts.

`observer doctor` prints the report, `observer status` flags a non-zero count,
and the UI shows a banner. The emitter also reports *why* a payload failed to
parse, so a malformed delivery is never misreported as an unmapped event.

## Idempotency

Every event id is derived from the delivery id (`<deliveryId>#<index>`), and the
event log has a unique index on it. That makes three otherwise dangerous things
safe:

- replaying the spool after a crash,
- a hook retrying,
- the Copilot log tailer re-reading a region of a file.

The reducer is idempotent on top of that: applying the same event twice produces
the same state, so a duplicate that slips through still cannot corrupt the graph.

## Order tolerance

Hooks arrive out of order in normal operation. A subagent can report its start
before the parent's spawning tool call returns; a tool result can arrive before
its call. The reducer handles this by:

- creating placeholder sessions and agents on first reference,
- filling in a parent when the edge is later reconciled,
- refusing to let a late event downgrade provenance or erase captured text,
- refusing to move a terminal agent back to running.

## Provenance

Three levels, attached to edges and model attribution:

| Level           | Meaning                                                |
| --------------- | ------------------------------------------------------ |
| `authoritative` | The host stated it directly, with real ids             |
| `reconciled`    | Joined from two authoritative signals                  |
| `inferred`      | Derived heuristically, usually by timing or naming     |

The UI renders reconciled edges dashed and inferred edges faint, and shows the
level as a badge on model attribution. This is why Observer can support four
hosts of very different capability without misleading anyone.

## Seat control

Seating is advisory: the matcher picks an employee, the node is labelled, and
the subagent is briefed with a persona directive. None of that changes what the
host runs. **Seat control** (`seats.control`, off by default) is the one path
where Observer stops observing and acts.

Only OpenCode can honour it. The mechanism is forced by the host:

```text
seats.employees.<id>.model
  -> observer install opencode
  -> ~/.config/opencode/agent/observer-<id>.md      (hidden, mode: subagent)
  -> plugin rewrites args.subagent_type at tool.execute.before,
     but only when it was `general`
  -> task tool resolves the agent, and uses its model
```

There is no shorter route. OpenCode's task tool accepts
`{description, prompt, subagent_type, …}` and no model, and it applies a
`variant` only when the resolved agent sets its own `model`
(`variant: agent.model ? undefined : parentEffort`). So an effort without a
model is a no-op, and the only lever is which agent the delegation names.

### Why only `general` is ever replaced

`subagent_type` does not select a model. It selects an entire agent definition:
prompt, tool permissions, mode. Substituting a generated seat agent for it
discards everything the named agent was for and keeps only the model.

`general` is the only built-in that ships with no prompt and no tool
restriction, which is what makes the swap lossless there — it changes the model
and nothing else. `explore` is the case that settles it: it carries a
substantial specialised prompt *and* a deny-by-default permission set that
allows only reads and searches (`{permission: "*", pattern: "*", action:
"deny"}` followed by explicit allows for `read`, `grep`, `glob` and `list`).
Honouring a model
preference by silently dropping a read-only guarantee is not a trade Observer
is entitled to make, so a delegation to `explore`, to any other built-in, or to
a user-written agent is left exactly as the model wrote it — the same fallback
as a missing definition. The user keeps their agent; they lose the model for
that one task, and `observer install`, `observer config` and `observer doctor`
all say so.

## Subagent identity and coordination

OpenCode's child session id is the stable subagent id. It is also the host's `task_id` resume token,
so Observer stores and exposes that value instead of minting a second resume scheme. Observer does
mint an assignment UUID before the child exists; `tool.execute.after` binds that correlation id to
the host session id from task metadata.

Assignments and direct messages live in SQLite. Plugin restarts reload them through the daemon,
which removes the former dependency on in-memory title matching. Title matching remains only as a
fallback for a live task when host metadata or the daemon is unavailable.

Assignment prompts and direct-message text pass through the same capture switches and redaction
rules as observed prompts and chat. Session deletion and retention pruning remove the related
coordination rows.

The OpenCode plugin registers three coordination tools:

- `agent_identity` returns the caller's stable id, resume token and peers.
- `agent_send` writes an addressed mailbox entry and prompts the recipient's existing session.
- `agent_inbox` reads queued messages if immediate host delivery failed.
- `agent_ack` removes processed message IDs from later inbox reads.

Immediate delivery remains in the mailbox until the recipient acknowledges the message id. This
avoids losing a message when OpenCode accepts a queued turn but the turn is later interrupted.

Messages may only address assignments under the same host root session. Sending also emits a
`messaged` edge, but it never changes the spawn parent. Sender and recipient budgets each cap direct
messages at 30 per minute. `agent_spawn` respects OpenCode's configured depth with a hard ceiling
of 8 and enforces an active fan-out of 16. OpenCode otherwise strips `task` from child sessions, so
the plugin adds `task: allow` only to `general` and generated Observer seats when no global,
wildcard or per-agent task policy exists. Coordination tools check the resolved session rules when
they run, and nested children inherit parent restrictions. OpenCode's default depth is 1, which
forbids a subagent from creating a child; Observer changes that default to 8 but leaves any explicit
user value intact.

The allow-list is a named constant, `NEUTRAL_AGENT_TYPES`, and — like the
naming rule — it exists in both `packages/cli/src/seat-agents.ts` and
`integrations/opencode/observer-plugin.js`, pinned together by a test. Adding
an entry is one edit if OpenCode ever ships another neutral agent.

### Why the plugin asks the host, not the disk

The task tool does this:

```js
const agent = await agents.get(args.subagent_type)
if (!agent) return fail(`Unknown agent type: ${args.subagent_type} …`)
```

Rewriting `subagent_type` to a name that is not in the registry does not
degrade the delegation — it kills it. That happens for entirely ordinary
reasons: the config was edited without re-running the installer, the agent
directory was cleaned out, OpenCode has not restarted since the files were
written, or a dotfiles repo carried the config to a machine where the installer
never ran.

So the plugin verifies before it rewrites, using `client.app.agents()`
(`GET /agent`) — the host's own registry, the same one the task tool fails
against. A filesystem check was rejected: OpenCode globs its agent directory
once at startup and never rescans, so a file can exist on disk and still be
unknown to the running host. Only the host's answer is evidence. The result is
cached, so a burst of parallel delegations costs one loopback request.

Every uncertainty falls back to the original `subagent_type`: control off, no
model configured, a `subagent_type` outside `NEUTRAL_AGENT_TYPES`, host
unreachable, agent absent. Losing a model preference for one task is
recoverable; losing the task is not. This is the same rule as the rest of the
plugin, where every error path is swallowed.

### Where the persona lives

The directive is appended to the task prompt by the plugin, and is deliberately
**not** written into the generated agent file. Three reasons, in order of
weight:

1. It has to survive the fallback. If the persona lived only in the file, the
   silent decline above would also silently drop the employee's briefing.
2. It is built per task by the daemon, and carries the seat's configured
   skills. A file written at install time would freeze it.
3. Employees with no configured model get no file at all, and must still be
   briefed.

The generated file therefore has an empty body. OpenCode sets `prompt` to the
trimmed body and uses it only when truthy, falling back to the provider default
— which is exactly what the built-in `general` subagent does, because it ships
with no prompt either. An empty body is how a generated agent stays a plain
worker rather than acquiring a second, stale personality.

The same reasoning forces the `todowrite` permission the file carries.
`general` denies `todowrite`; a bare generated agent does not, so without it
seating an employee would quietly *grant* a delegated subagent the right to
rewrite the parent session's todo list. That is the same class of silent change
`NEUTRAL_AGENT_TYPES` exists to prevent, just smaller. Generated seats also
allow `task` and Observer's coordination tools so they can nest and communicate;
those additions do not grant file, shell or network access. Keep `todowrite` in
step with whatever `general` denies; a diff against a running host is how to
check.

### Reconciliation, not delta

`syncSeatAgents` reads the whole agent directory and makes it match the config
on every run, rather than applying the change the user just made. Two failure
modes drive that:

- `control: false` has to *remove* the definitions, not merely stop consulting
  them. A stale file keeps billing the user for a model they stopped asking
  for.
- A crash between two writes leaves a partial state that a delta would never
  correct.

Deletion is authorised by a marker inside the file, not by its name, so a
hand-written `observer-notes.md` survives both a sync and an uninstall. The
marker is a YAML comment: OpenCode's frontmatter parser drops comments, so it
is evidence to Observer and invisible to the host.

A seat that `diagnoseSeats` reports as an *error* — an unknown employee id, or
a model missing its provider — gets no file. This matters more than it sounds:
a definition with a malformed model still loads, still appears in the registry,
and so still passes the plugin's existence check, and only then fails when the
model is resolved. Not writing it turns a broken task back into a no-op.

### A variant the model does not declare

The same failure has a second cause, and the existence check cannot see it
either. OpenCode validates `variant` **per model at use time**, not at load
time:

```js
if (x.variant && !R.variants?.[x.variant]) return fail(new UnknownEffort({ effort: x.variant }))
```

So `{"model": "anthropic/claude-opus-4-5", "variant": "xhigh"}` on a model
offering only low/medium/high writes a valid file, loads, appears in
`GET /agent`, passes the plugin's check, and then kills the delegation. Same
remedy, therefore: `syncSeatAgents` writes no file and puts the reason in
`notes`.

The rule lives in `packages/cli/src/seat-agents.ts` rather than in
`diagnoseSeats`, because answering it needs the host's model catalogue at
`~/.cache/opencode/models.json` — a CLI-side cache the daemon has no business
reading and must stay answerable without. That does not create a third
vocabulary for "this seat is broken":

- `diagnoseSeats` (daemon) still owns whether a seat is *configured* wrongly.
- `variantsFor` (`packages/cli/src/models.ts`) still owns what a model
  *declares*, and whether Observer is entitled to speak for it at all.
- `seat-agents.ts` only decides whether a file gets written, which is the one
  judgement it has always made.

**The check is deliberately one-sided.** It refuses only when the catalogue
gives a non-empty effort scale that excludes the seat's variant. Three cases
write the file anyway:

- *No catalogue, or a corrupt one.* Silence is not a verdict.
- *A model the catalogue has never heard of.* An unknown model is not a wrong
  model; the host is the authority and models ship faster than snapshots.
- *A model whose effort scale Observer cannot work out.* This is the subtle
  one. models.dev publishes a list of reasoning *mechanisms*, and OpenCode
  synthesises a variant map for the ones that are not `effort` using rules
  keyed on the model family and the provider's SDK — a `budget_tokens` model
  genuinely accepts `high` and `max` while declaring no effort scale at all.
  958 of the models in the current catalogue are in that position.
  `variantsFor` answers `known: false` for them, so they take the
  unknown-model branch above and the file is written.

`variantsFor` therefore reports three states and never two, because "this
model takes no reasoning effort" and "we cannot tell what this model takes"
are different answers and only one of them is a verdict:

| `ModelVariants`               | meaning                        | `variantsFor`                        |
| ----------------------------- | ------------------------------ | ------------------------------------ |
| `{ kind: "efforts", values }` | offer exactly these            | `{ values, known: true }`            |
| `{ kind: "none" }`            | the model takes no effort      | `{ values: [], known: true }`        |
| `{ kind: "unknown" }`         | we cannot tell; host rules     | `{ values: SEAT_VARIANTS, known: false }` |

Measured against a live host (`opencode serve`, `GET /provider`, 7,202
models): every one of the 3,506 catalogued models with no mechanisms at all
resolves to an empty variant map, so `none` is a safe verdict; the 940 with
mechanisms but no `effort` entry split 594 to none against 346 to a
synthesised map, which is why they must say `unknown`.

The one thing the catalogue cannot get right is that the host's synthesis is
keyed on the provider's *SDK package* as well as the model: 48 models across
five packages (`@aihubmix/ai-sdk-provider`, `@ai-sdk/perplexity`,
`gitlab-ai-provider`, `@qvac/ai-sdk-provider`, `watsonx-ai-provider`) publish a
full effort scale and accept no variant whatever. Nothing on disk distinguishes
them, so `listModels({ probeHost: true })` reads the host's resolved map out of
`opencode models --verbose` and lets it overrule the catalogue outright. That
map is the same object `GET /provider` serves and the same one the task tool
validates against, and with it the disagreement count over all 7,202 models is
zero. It costs ~2.7 s of subprocess against ~80 ms for the cache, so it stays
opt-in (`observer config --probe`).

The catalogue is read once per sync, and only when some seat actually pairs a
model with a variant.

The naming rule (`arjun-mehta` -> `observer-arjun-mehta`) exists in two places:
`packages/cli/src/seat-agents.ts` and `integrations/opencode/observer-plugin.js`,
which is dependency-free plain JavaScript copied verbatim into the user's config
directory and cannot import it. A test loads the plugin's copy and compares its
output against the original, because drift there would be silent — the installer
would write one name and the plugin would ask for another.

### The config UI

`observer config` is the one screen where seat control is *changed* rather than
reported, so it opens on a menu whose first row is the flag itself. Nothing a
user needs sits behind a key they have to be told about; `c` still toggles from
anywhere, but it is now a shortcut rather than the only way in. Views unwind one
level per esc — `models` -> `employee` -> `employees` -> `menu` — and only the
menu ends the session, so backing out of a picker can never quit by accident.

The split is three files and holds strictly:

```text
config-ui-state.ts    every transition, pure, no I/O
config-ui-render.ts   state -> lines of text, pure, no environment reads
config-ui.ts          raw mode, keypresses, saving, restoring the terminal
theme.ts              colour mode and the Forgeline palette
```

Colour is an overlay the caller opts into: `render` emits no ANSI unless the
viewport carries a theme, so a pipe, a test assertion and a screen reader all
get the same text a terminal draws. The shell resolves the mode once with
`colorSupport` (`NO_COLOR`, `FORCE_COLOR`, TTY, `TERM=dumb`) and hands down a
theme, which is why no view function reads `process.env`. Every distinction is
still carried by characters — `>` for the cursor, `!` for a flagged seat,
`warning:`/`error:` on findings, brackets on the armed effort — and colour only
repeats them. Palette roles come from `.scratch/forgeline-palette.html`; the two
background swatches are deliberately unused, because a full-screen UI that
paints its own background overrides the user's terminal theme.

## Storage

SQLite through Node's built-in `node:sqlite`, so there is no native module to
compile. Schema changes are append-only migrations tracked with
`PRAGMA user_version`.

Entity ids are deterministic and composed with `~`:

```text
session          claude:abc123
agent            claude:abc123~agent:a1
message          claude:abc123~agent:a1~m:msg_7
```

They are printable and URL-safe because they travel through both SQLite text
columns and REST path parameters.

## Live updates

The reducer returns a `Change[]` for each event. The broadcaster assigns a
cursor, keeps the last 2,000 batches, and pushes them to connected browsers.
A browser that reconnects sends its cursor:

- inside the buffer, it receives the missed batches;
- outside it, the server replies `resync` and the browser refetches from REST.

The client only stores messages, tool calls and prompt fragments for agents
whose detail panel has been opened, which keeps memory flat during long sessions
with many subagents.

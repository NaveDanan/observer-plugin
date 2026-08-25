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

## One source per fact

Idempotency only protects against the *same* fact arriving twice. It cannot help
when a host states one fact two different ways.

Copilot does exactly that with the opening prompt: `sessionStart` carries it as
`initialPrompt` and `userPromptSubmitted` carries it again as `prompt`, byte for
byte, moments apart. Nothing links the two, so both keys were legitimate and the
first turn was drawn twice.

The rule that resolves it is to pick one source per fact rather than to invent a
cleverer key. For Copilot, message text belongs to the session log
(`~/.copilot/session-state/<id>/events.jsonl`), not to hooks, and the adapter
emits no `message.user` at all. The log is the better source anyway:

- it carries the raw `content`, where hooks carry the model-facing
  `transformedContent` with system blocks injected into it;
- it carries `attachments`, which hooks do not expose at all;
- its `subagent.started` lines map a log `agentId` to an agent name, so subagent
  transcripts land on the right node instead of being dropped.

Attachments are recorded, never copied. Observer stores the path and mints an id
from it, and `/v1/attachments/:id` serves the bytes off disk. The browser can
only ever name an id, so the stored rows are the allowlist and a path cannot be
supplied as a parameter.

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

The roster and model pins are separate concepts. Installing Observer exposes
every employee as a native custom agent, even when the employee has no seat
configuration. The harness may select an employee when the employee's
description fits the task. Observer does not rewrite generic delegations to
force an employee.

**Seat control** (`seats.control`, off by default) controls only model pins.
With it on, a target adds supported model options to that employee's native
definition. With it off, or without a target, the definition omits model fields
and the harness inherits or chooses the model.

| Harness | Native employee definition | Supported pin fields |
| --- | --- | --- |
| OpenCode | `~/.config/opencode/agent/observer-<id>.md` | `model`, `variant` |
| Codex | `~/.codex/agents/observer-<id>.toml` | `model`, `model_reasoning_effort`, `service_tier` |
| Claude Code | `~/.claude/agents/observer-<id>.md` | `model`, `effort` |
| Copilot | `~/.copilot/agents/observer-<id>.agent.md` and plugin copies | `model`, plus Observer-owned effort/context settings |

All definitions carry the employee behavior directive and configured skills.
Harnesses load custom agents at startup, so configuration changes require a
restart. Sync renders the full roster each time. Turning seat control off
rewrites pinned employees without model fields; it does not remove employees.
Observer overwrites or deletes only files carrying its ownership marker.

## Subagent identity and coordination

OpenCode's child session id is the stable subagent id. It is also the host's `task_id` resume token,
so Observer stores and exposes that value instead of minting a second resume scheme. Observer does
mint an assignment UUID before the child exists; `tool.execute.after` binds that correlation id to
the host session id from task metadata.

Every assignment also carries the spawner's host runtime id. A top-level subagent names the root
session id as its parent; `null` never means "parented by root". The daemon rejects an assignment
without that id, and the plugin does not forward a child session until its parent chain resolves.
This keeps the one root agent as the only parentless node and prevents a transient host lookup from
creating a second root or a floating subagent.

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
messages at 30 per minute. Native `task` calls and `agent_spawn` cap each root session at 15 distinct
subagents. They respect a lower OpenCode depth setting and otherwise allow three session levels:
the root, its subagent, and that subagent's child. Resuming a stable `task_id` creates no subagent and
does not consume another slot. OpenCode otherwise strips `task` from child sessions, so
the plugin adds `task: allow` only to `general` and generated Observer seats when no global,
wildcard or per-agent task policy exists. Coordination tools check the resolved session rules when
they run, and nested children inherit parent restrictions. OpenCode's default depth is 1, which
forbids a subagent from creating a child. Observer changes that default to 2 parent edges, which
produces the three session levels, but leaves any explicit lower user value intact.

These are daemon invariants as well as plugin checks. The coordination API rejects the sixteenth
assignment for a root, rejects a parent chain deeper than two subagent edges, and does not allow an
existing assignment to change its parent or runtime id. Finished assignments still count toward the
15-agent lifetime cap; resuming an existing runtime id does not. The plugin reserves slots before
parallel OpenCode creation begins, while the daemon serially checks durable assignments before each
insert, so concurrent calls cannot all pass against the same final slot.
New creation is fail-closed when the daemon cannot supply or persist that durable count: native
`task` and `agent_spawn` refuse to create a child instead of trusting a process-local count that a
plugin restart could have reset. Resuming an existing `task_id` is not creation and remains outside
the slot reservation path.

### Where the persona lives

Native employee definitions carry the stable roster behavior and configured
skills. OpenCode's runtime matcher may also append a task-specific staffing
note when the host uses a generic subagent. That note labels and briefs the
observed task; it does not change the selected agent type or model.

### Reconciliation, not delta

Each sync renders all roster employees. Invalid or unsupported targets omit
the pin while leaving the employee available with the harness model. Deletion
and overwrites require an Observer marker, so hand-written collisions survive
sync and uninstall.

### A variant the model does not declare

The same failure has a second cause, and the existence check cannot see it
either. OpenCode validates `variant` **per model at use time**, not at load
time:

```js
if (x.variant && !R.variants?.[x.variant]) return fail(new UnknownEffort({ effort: x.variant }))
```

So `{"model": "anthropic/claude-opus-4-5", "variant": "xhigh"}` on a model
offering only low/medium/high would fail when the employee runs. The sync keeps
the employee definition but omits the invalid model pin and puts the reason in
`notes`.

The rule lives in `packages/cli/src/seat-agents.ts` rather than in
`diagnoseSeats`, because answering it needs the host's model catalogue at
`~/.cache/opencode/models.json` — a CLI-side cache the daemon has no business
reading and must stay answerable without. That does not create a third
vocabulary for "this seat is broken":

- `diagnoseSeats` (daemon) still owns whether a seat is *configured* wrongly.
- `variantsFor` (`packages/cli/src/models.ts`) still owns what a model
  *declares*, and whether Observer is entitled to speak for it at all.
- `seat-agents.ts` only decides whether the pin fields get written.

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

Collection APIs use keyset pagination rather than offsets. Session cursors are
opaque and encode the `(updated_at, id)` sort key; raw-event cursors are event
sequence numbers. Responses keep their named collection and add
`page: { nextCursor, hasMore }`. Limits are validated and capped at 100 sessions
or 500 events, keeping read cost bounded as the event log grows.

Retention deletes expired projections in set-based statements inside one
transaction. Composite indexes cover session paging, running-tool lookup, and
coordination rate limits; WAL writers wait briefly for transient contention
instead of failing immediately.

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

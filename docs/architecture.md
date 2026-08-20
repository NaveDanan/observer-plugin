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
| `filtered`  | no     | Capture settings removed it deliberately       |
| `duplicate` | no     | Already stored, expected during spool replay   |

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

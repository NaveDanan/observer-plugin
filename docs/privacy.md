# Privacy and data handling

Observer captures prompts, chat history, tool arguments and tool output. That is
sensitive material, so this document states exactly what happens to it.

## Where data lives

| Path                        | Contents                                          |
| --------------------------- | ------------------------------------------------- |
| `~/.observer/observer.db`   | Event log and projected entities (SQLite)         |
| `~/.observer/config.json`   | Port, auth token, capture and redaction settings  |
| `~/.observer/spool/*.jsonl` | Deliveries captured while the daemon was down     |
| `~/.observer/daemon.log`    | Daemon stdout/stderr                              |

The directory is created with mode `0700` and the config file with `0600`.
Set `OBSERVER_HOME` to relocate all of it.

Nothing is sent anywhere. The daemon has no outbound network calls.

Direct subagent message text and assignment prompts use the existing `capture.messages`,
`capture.prompts` and redaction rules before reaching `observer.db`. Routing metadata remains even
when content capture is off. The OpenCode plugin may send a message to an existing local OpenCode
child session through OpenCode's loopback SDK. It does not contact an external service. Any local
process that can read Observer's bearer token can use the same coordination API, just as it can use
the existing ingest and session APIs.

## Network exposure

- Listens on `127.0.0.1` only.
- Every API route except `/health` and `/v1/bootstrap` requires
  `Authorization: Bearer <token>`.
- The `Host` header must be a loopback name. This blocks DNS rebinding, where a
  page you visit resolves its own hostname to `127.0.0.1` to reach local
  services.
- No CORS headers are sent, so another origin cannot read responses.

`/v1/bootstrap` returns the token to the local UI. It is protected by the two
rules above, and the same token is already readable in `~/.observer/config.json`
by any process running as you.

## Redaction

Redaction runs at ingest, before the database write. Data that is redacted is
never stored, so it cannot leak from the database later.

Removed by default:

- Provider tokens (`sk-…`, `ghp_…`, `github_pat_…`, `xox…`, `AKIA…`, `AIza…`)
- JSON Web Tokens
- PEM private key blocks
- `Authorization` header values
- Assignments whose key name looks sensitive
  (`API_KEY=…`, `DB_PASSWORD=…`, `*_SECRET=…`, `*_TOKEN=…`)

Strings are also capped at 64,000 characters.

Redaction is pattern-based and therefore best effort. It will not catch a secret
that looks like ordinary prose.

## Capture switches

In `~/.observer/config.json`, under `capture`. Each switch drops data at ingest.

| Switch       | Default | Effect when off                                  |
| ------------ | ------- | ------------------------------------------------ |
| `messages`   | on      | No user or assistant text is stored              |
| `reasoning`  | **off** | Raw chain-of-thought is never stored             |
| `toolInput`  | on      | Tool arguments are dropped                       |
| `toolOutput` | on      | Tool results are dropped                         |
| `prompts`    | on      | System, agent and delegation prompts are dropped |
| `rawEvents`  | **off** | The untranslated host payload is not kept        |

`reasoning` and `rawEvents` are off by default because they are the most
sensitive and least useful data to retain.

Restart the daemon after editing the file:

```bash
observer stop && observer start
```

## Retention and deletion

- `retentionDays` (default 30) prunes ended sessions, direct messages and old
  events on start and every five minutes. Set it to `0` to keep data indefinitely.
- **Delete session data** in the UI removes a session, its assignments, direct
  messages, agents, chat messages, tool calls, todos, prompts and raw events.
- `rm -rf ~/.observer` removes everything Observer has ever stored.
- `observer uninstall all` removes the hooks from your hosts. It only deletes
  entries Observer created and leaves your own hooks untouched; a backup of each
  edited file is written alongside it as `<file>.observer-backup`.

## Diagnostics

`observer doctor` and `/v1/diagnostics` report deliveries that could not be
recorded. To make that useful without weakening privacy, a fault sample keeps:

- the host and event name,
- the reason, and the parser error where there is one,
- the payload's **top-level key names only**.

Values are never stored, so a sample can show that `session_id` was missing
without retaining the prompt that came with it. Samples live in memory only and
are lost when the daemon stops.

## What Observer never does

- Never sends data off the machine.
- Never stores host credentials or API keys of its own.
- Never modifies a hook decision: the emitter writes nothing to stdout and always
  exits 0, so it cannot allow, deny or alter a tool call.
- Never writes into your root agent session. Direct subagent messaging adds a user message to the
  addressed child session so that exact subagent context can respond.

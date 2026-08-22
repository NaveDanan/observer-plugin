/**
 * Schema migrations.
 *
 * Each entry is applied exactly once, in order, tracked with `PRAGMA user_version`.
 * Never edit an existing entry after release - append a new one instead.
 */
export const MIGRATIONS: string[] = [
  // 1: event log + projected entities
  `
  CREATE TABLE events (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    id             TEXT NOT NULL UNIQUE,
    host           TEXT NOT NULL,
    host_version   TEXT,
    adapter        TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    session_key    TEXT NOT NULL,
    agent_key      TEXT NOT NULL,
    kind           TEXT NOT NULL,
    at             INTEGER NOT NULL,
    received_at    INTEGER NOT NULL,
    provenance     TEXT NOT NULL,
    body           TEXT NOT NULL,
    raw            TEXT
  );
  CREATE INDEX events_by_session ON events(host, session_key, seq);
  CREATE INDEX events_by_received ON events(received_at);

  CREATE TABLE sessions (
    id             TEXT PRIMARY KEY,
    host           TEXT NOT NULL,
    host_version   TEXT,
    session_key    TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    title          TEXT,
    status         TEXT NOT NULL,
    model          TEXT,
    goal           TEXT,
    goal_status    TEXT,
    cwd            TEXT,
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER,
    updated_at     INTEGER NOT NULL,
    last_event_seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sessions_by_updated ON sessions(updated_at DESC);

  CREATE TABLE agents (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    agent_key         TEXT NOT NULL,
    agent_type        TEXT NOT NULL,
    display_name      TEXT,
    parent_agent_id   TEXT,
    status            TEXT NOT NULL,
    model             TEXT,
    model_confidence  TEXT,
    description       TEXT,
    delegation_prompt TEXT,
    summary           TEXT,
    started_at        INTEGER NOT NULL,
    ended_at          INTEGER,
    updated_at        INTEGER NOT NULL,
    total_tokens      INTEGER,
    duration_ms       INTEGER,
    UNIQUE(session_id, agent_key)
  );
  CREATE INDEX agents_by_session ON agents(session_id);

  CREATE TABLE edges (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    to_agent_id   TEXT NOT NULL,
    edge_type     TEXT NOT NULL,
    label         TEXT,
    provenance    TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX edges_by_session ON edges(session_id);

  CREATE TABLE messages (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    role        TEXT NOT NULL,
    message_key TEXT NOT NULL,
    text        TEXT NOT NULL,
    streaming   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    seq         INTEGER NOT NULL
  );
  CREATE INDEX messages_by_agent ON messages(agent_id, seq);

  CREATE TABLE tool_calls (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    call_id     TEXT NOT NULL,
    tool        TEXT NOT NULL,
    title       TEXT,
    input       TEXT,
    output      TEXT,
    error       TEXT,
    status      TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    duration_ms INTEGER
  );
  CREATE INDEX tool_calls_by_agent ON tool_calls(agent_id, started_at);

  CREATE TABLE todos (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    position        INTEGER NOT NULL,
    content         TEXT NOT NULL,
    status          TEXT NOT NULL,
    original_status TEXT,
    priority        TEXT,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX todos_by_agent ON todos(agent_id, position);

  CREATE TABLE prompt_fragments (
    id           TEXT PRIMARY KEY,
    session_id   TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    fragment_key TEXT NOT NULL,
    prompt_kind  TEXT NOT NULL,
    label        TEXT NOT NULL,
    text         TEXT,
    path         TEXT,
    availability TEXT NOT NULL,
    note         TEXT,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX prompt_fragments_by_agent ON prompt_fragments(agent_id);
  `,
  // 2: durable subagent identity, resume state and peer mail
  `
  ALTER TABLE agents ADD COLUMN runtime_id TEXT;

  CREATE TABLE agent_assignments (
    id                TEXT PRIMARY KEY,
    host              TEXT NOT NULL,
    root_session_key  TEXT NOT NULL,
    runtime_id        TEXT,
    parent_runtime_id TEXT,
    call_id           TEXT,
    agent_type        TEXT NOT NULL,
    host_agent_type   TEXT NOT NULL,
    description       TEXT,
    prompt            TEXT,
    status            TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  CREATE INDEX assignments_by_root ON agent_assignments(host, root_session_key, created_at);
  CREATE UNIQUE INDEX assignments_unique_call ON agent_assignments(host, root_session_key, call_id) WHERE call_id IS NOT NULL;
  CREATE UNIQUE INDEX assignments_by_runtime ON agent_assignments(host, runtime_id) WHERE runtime_id IS NOT NULL;

  CREATE TABLE agent_mail (
    id                TEXT PRIMARY KEY,
    host              TEXT NOT NULL,
    root_session_key  TEXT NOT NULL,
    from_runtime_id   TEXT NOT NULL,
    to_runtime_id     TEXT NOT NULL,
    text              TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    delivered_at      INTEGER,
    read_at           INTEGER
  );
  CREATE INDEX agent_mail_inbox ON agent_mail(host, root_session_key, to_runtime_id, read_at, created_at);
  `,
  // 3: code churn contribution ledger
  `
  ALTER TABLE agents ADD COLUMN lines_added INTEGER;
  ALTER TABLE agents ADD COLUMN lines_removed INTEGER;
  ALTER TABLE agents ADD COLUMN churn_confidence TEXT;
  ALTER TABLE tool_calls ADD COLUMN lines_added INTEGER;
  ALTER TABLE tool_calls ADD COLUMN lines_removed INTEGER;
  ALTER TABLE tool_calls ADD COLUMN churn_confidence TEXT;
  `,
]

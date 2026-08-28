# Portable agent mail

Observer's durable subagent mailbox must be available in every host that can load the Observer plugin, not only OpenCode.

## Required behavior

- Claude Code, Codex, and Copilot installs register an Observer stdio MCP server.
- The MCP server exposes `agent_identity`, `agent_send`, `agent_inbox`, and `agent_ack` with the same message semantics as OpenCode.
- `agent_send` writes through the daemon's existing coordination API. Hosts that cannot resume an addressed subagent keep the message queued for `agent_inbox`.
- Claude Code, Codex, and Copilot subagent lifecycle events populate the daemon's durable assignment table so mailbox addresses are scoped to one host session tree.
- The caller can be resolved from host-provided session metadata or an explicit stable subagent ID. The server must never guess across active sessions.
- Existing capture, redaction, retention, same-session validation, and rate-limit rules continue to apply.

## Acceptance criteria

- Generated Codex and Copilot plugin manifests point to a bundled `.mcp.json` file, and Claude Code receives an equivalent user-scoped MCP entry.
- Both bundles contain a runnable coordination MCP entry point.
- Claude Code, Codex, and Copilot observed subagents with stable runtime IDs appear in `/v1/coordination/assignments`.
- MCP protocol tests cover discovery, identity, send, inbox, acknowledgement, missing identity, and daemon errors.
- Plugin packaging tests cover the MCP manifest and script for both hosts.
- Integration documentation no longer describes coordination tools as OpenCode-only.

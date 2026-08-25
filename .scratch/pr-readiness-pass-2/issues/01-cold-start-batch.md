# Preserve the OpenCode cold-start batch

Status: ready-for-agent

`integrations/opencode/observer-plugin.js` removes a batch from its queue before `fetch`. When the
daemon is down, the catch starts it but discards the batch that triggered startup. Preserve and
retry or spool that exact batch without delaying or breaking the host session.

Acceptance: an end-to-end or faithful integration test proves the first turn is captured after an
autostart, without requiring a second user turn.

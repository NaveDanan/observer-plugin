# Preserve Windows hook paths

Status: ready-for-agent

Direct and plugin Codex hook commands use bare `node` and unquoted script paths. Generate a command
that survives spaces in both the executable and script paths while respecting Codex's Windows
command wrapping.

Acceptance: tests execute or parse commands for paths containing spaces and prove both paths remain
single arguments.

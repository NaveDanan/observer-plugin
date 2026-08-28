# Add portable coordination MCP tools

Type: task
Status: ready-for-agent

Implement the portable agent mailbox described in `../spec.md` for Claude Code, Codex, and Copilot while preserving OpenCode behavior.

## Comments

- 2026-08-28: Claimed for implementation after a Codex sibling-message test exposed that Observer coordination tools were absent outside OpenCode.
- 2026-08-28: Implemented one durable MCP-backed mailbox for Claude Code, Codex, and Copilot, retained OpenCode's immediate-resume path, and verified the complete 1,382-test suite.

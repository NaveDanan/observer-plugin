# Codex Observer context and task visibility

## Problem

Observer's Codex integration omitted the root transcript, displayed inherited
root bootstrap content as a child's conversation, gave explicit Observer
invocations too little staffing guidance, and did not show a stable assignment
on every subagent node.

## Requirements

1. Recover the root user's and assistant's messages from Codex's root
   `transcript_path`.
2. Start every newly spawned Codex child with `fork_turns: "none"`. Recover a
   child's displayed chat from its assignment onward so old root content and
   `<recommended_plugins>` metadata never appear on the child node.
3. Ship a user-invoked Observer skill containing the complete employee roster,
   capabilities, native agent ids, a strong preference for employee agents,
   and a requirement to explain use of a default agent.
4. Show a visible task title on every non-root node. Prefer the host's short
   description, then the delegation prompt, then the first child user message.

## Architecture boundary

`observer-emit` remains observation-only and stdout-silent. Codex spawn input is
rewritten by the separate `observer-codex-control` executable on `PreToolUse`.
It preserves every supplied input field except `fork_turns`, fails open for
unknown input, and never denies a tool call. This is context isolation, not the
model-routing prototype tracked by `multi-provider-seats/issues/09`.

## Verification

- Adapter recovery tests cover complete root history and assignment-scoped
  child history containing inherited plugin metadata.
- Control tests cover all supported Codex spawn tool names, field preservation,
  malformed input, and the standalone process.
- Generated-plugin tests cover hook ordering and the complete Observer skill.
- Reducer and web tests cover stable cross-host task-title fallback and visible
  task-title selection.

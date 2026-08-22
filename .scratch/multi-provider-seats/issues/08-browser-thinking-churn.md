# 08 Browser: thinking, tool calls and code churn

Status: ready-for-agent
Type: task
Blocked by: none
Owner seat: arjun-mehta

Runs in parallel with 01 through 07. It shares no files with them.

## Files owned

- `apps/web/src/DetailPanel.tsx`, `apps/web/src/AgentNode.tsx`, `apps/web/src/App.tsx`
- `apps/web/src/store.ts`, `apps/web/src/styles.css`
- `packages/core/src/reduce.ts`, `packages/protocol/src/entities.ts`
- matching tests

Do not touch `apps/daemon/src/seats.ts` or anything under `packages/cli/`.

## State of play

- Thinking is already plumbed: `message.reasoning` exists, the pipeline honours
  `capture.reasoning`, and `DetailPanel.tsx:135` already labels it "Thinking".
  `capture.reasoning` is now `true`, so verify it renders rather than rebuilding it.
- Tool calls already render.
- Churn is new. There is no `linesAdded`/`linesRemoved` anywhere. `.diff-badge` and
  `.diff-add` exist in `styles.css` but `App.tsx:181` currently reuses them for agent
  counts, so pick distinct class names.

## Do

1. Confirm reasoning renders end to end now that capture is on. Fix the display path only
   if it is genuinely broken.
2. Add `linesAdded` and `linesRemoved` to the agent entity, accumulated in the reducer from
   completed edit and write tool calls. Keep the reducer idempotent: the same event applied
   twice must not double-count. Key the contribution by tool call id.
3. Render churn as `+N` in green and `-N` in red on the node and in the detail panel. Show
   nothing when both are zero rather than `+0 -0`.
4. Carry a provenance value. Churn derived from tool arguments is `inferred`; only churn a
   host states outright is `authoritative`. Render it the way existing provenance is shown.

## Definition of done

- Reasoning appears for a live OpenCode session.
- Replaying the same tool-result event twice leaves the counts unchanged.
- An agent with no edits shows no churn badge.
- Colour is not the only carrier: `+` and `-` remain in the text.

## Do not

- Do not invent churn for a tool whose result does not state it.
- Do not reuse `.diff-badge`, which already means something else.

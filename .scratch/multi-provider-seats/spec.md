# Multi-provider employee seats

Status: ready-for-agent

Give every roster employee a model and reasoning configuration per host, across the five
CLIs t3code drives (OpenCode, Codex, Claude Code, Cursor, Grok), and show reasoning, tool
calls and code churn for those agents in the browser.

Research: `docs/research/multi-provider/combined.html` and the five provider guides beside it.

## Why the current shape blocks this

- `SeatSpec.model` requires a `/` (`apps/daemon/src/seats.ts:213`). That rejects Codex
  `gpt-5.6-sol` and Grok `grok-build`. The rule is OpenCode policy living in shared code.
- One `variant` string cannot hold Claude's effort plus context window plus fast mode plus
  thinking, or Cursor's four independent ACP options.
- `models.ts`, `seat-agents.ts` and the plugin hard-code OpenCode cache paths, agent-file
  format and the `general` rewrite. Nothing else can reuse them.

## Target shape

An employee has shared `skills` and zero or more host targets. A target names a host
profile, stores an **opaque** model id, and carries **typed** options.

```jsonc
{
  "seats": {
    "control": true,
    "employees": {
      "arjun-mehta": {
        "skills": ["design-systems"],
        "targets": {
          "opencode:default": {
            "host": "opencode",
            "model": "anthropic/claude-opus-4-8",
            "options": [{ "id": "variant", "value": "high" }]
          },
          "codex:default": {
            "host": "codex",
            "model": "gpt-5.6-sol",
            "options": [{ "id": "reasoningEffort", "value": "high" }]
          }
        }
      }
    }
  }
}
```

Legacy top-level `model`/`variant` load as an `opencode:default` target and are rewritten
on the first save. Unknown fields keep surviving exactly as they do today.

## Capability truth

Discovery and control are separate. OpenCode and the local Copilot plugin have
supported control paths.

| Host | Model inventory | Child control |
| --- | --- | --- |
| OpenCode | CLI/server plus cache | supported, `general` rewrite only |
| Codex | live `model/list` | experimental, needs a synchronous `PreToolUse` prototype |
| Claude | versioned list, SDK later | off, needs generated definitions plus Agent rewrite |
| Copilot | CLI help/config | supported, local `general-purpose` rewrite only |
| Cursor | live ACP options | unsupported, no per-child setter exists |
| Grok | ACP session setup | unsupported, no child graph on main |

The TUI must render that status per target. It must never promote discovery into control.

## Non-negotiables

- Desired stays separate from observed. A configured effort is never written onto an agent.
- Every control failure preserves the user's delegation. Fail open, record a diagnostic.
- Only neutral delegations are ever rewritten. Specialised agents keep prompt and tools.
- Model ids are opaque above the adapter. The slash rule moves into the OpenCode adapter.

## Browser features

- **Thinking** is already plumbed end to end and was only gated by `capture.reasoning`,
  now on. Codex, Claude and Copilot adapters emit no reasoning events; that is the gap.
- **Tool calls** already render.
- **Code churn** is new. No `linesAdded`/`linesRemoved` exists. `.diff-badge`/`.diff-add`
  in `styles.css` are currently reused by `App.tsx:181` for agent counts.

## Subagent roster for this effort

| Seat | Model | Role |
| --- | --- | --- |
| malik-johnson | claude-opus-5 / max | contracts, Codex adapter |
| elias-mercer | claude-opus-5 / max | OpenCode extraction, Cursor adapter |
| nia-okafor | claude-opus-5 / max | Claude adapter, Grok adapter |
| arjun-mehta | claude-opus-5 / max | web UI: thinking, tool calls, churn |
| daniel-brooks | gpt-5.6-luna / max | auditor for every ticket |

Auditor findings return through the primary agent, which resumes the writer's session with
its `task_id`. There is no direct subagent-to-subagent channel.

import { describe, expect, it } from "vitest"
import { ignoresHook, normalizeHook } from "@observer-ai/adapters"
import type { AdapterEvent } from "@observer-ai/adapters"

function kinds(events: AdapterEvent[]): string[] {
  return events.map((event) => event.body.kind)
}

function find<K extends AdapterEvent["body"]["kind"]>(
  events: AdapterEvent[],
  kind: K,
): Extract<AdapterEvent["body"], { kind: K }> | undefined {
  return events.find((event) => event.body.kind === kind)?.body as
    | Extract<AdapterEvent["body"], { kind: K }>
    | undefined
}

describe("claude adapter", () => {
  it("ignores payloads without a session id", () => {
    expect(normalizeHook({ host: "claude", event: "SessionStart", payload: {}, deliveryId: "d" })).toEqual([])
  })

  it("captures the model and cwd at session start", () => {
    const events = normalizeHook({
      host: "claude",
      event: "SessionStart",
      deliveryId: "d",
      payload: { session_id: "s", source: "startup", model: "claude-opus-5", cwd: "/repo" },
    })
    expect(find(events, "session.started")).toMatchObject({ model: "claude-opus-5", cwd: "/repo" })
  })

  it("treats MessageDisplay as the only assistant text source", () => {
    const display = normalizeHook({
      host: "claude",
      event: "MessageDisplay",
      deliveryId: "d",
      payload: { session_id: "s", message_id: "m1", index: 0, final: true, delta: "hi" },
    })
    expect(find(display, "message.assistant.delta")).toMatchObject({ delta: "hi", final: true })

    // Stop must not emit a second copy of the same reply.
    const stop = normalizeHook({
      host: "claude",
      event: "Stop",
      deliveryId: "d2",
      payload: { session_id: "s", last_assistant_message: "hi" },
    })
    expect(kinds(stop)).not.toContain("message.assistant")
  })

  it("reconciles the spawn edge from the Agent tool result", () => {
    const events = normalizeHook({
      host: "claude",
      event: "PostToolUse",
      deliveryId: "d",
      payload: {
        session_id: "s",
        tool_name: "Agent",
        tool_use_id: "t1",
        tool_input: { prompt: "find things", description: "search", subagent_type: "Explore" },
        tool_response: { agentId: "a1", resolvedModel: "claude-haiku-4.5" },
      },
    })
    const spawn = events.find((event) => event.body.kind === "agent.started")
    expect(spawn?.agentKey).toBe("agent:a1")
    expect(spawn?.provenance).toBe("reconciled")
    expect(spawn?.body).toMatchObject({
      agentType: "Explore",
      parentAgentKey: "main",
      prompt: "find things",
      model: "claude-haiku-4.5",
    })
  })

  it("routes subagent tool calls to the subagent node", () => {
    const events = normalizeHook({
      host: "claude",
      event: "PreToolUse",
      deliveryId: "d",
      payload: { session_id: "s", agent_id: "a1", tool_name: "Grep", tool_use_id: "t9", tool_input: {} },
    })
    expect(events[0]?.agentKey).toBe("agent:a1")
  })

  it("maps TodoWrite onto normalized todos while keeping host wording", () => {
    const events = normalizeHook({
      host: "claude",
      event: "PostToolUse",
      deliveryId: "d",
      payload: {
        session_id: "s",
        tool_name: "TodoWrite",
        tool_use_id: "t1",
        tool_input: { todos: [{ content: "ship", status: "in_progress", priority: "high" }] },
        tool_response: {},
      },
    })
    expect(find(events, "todos.updated")?.todos[0]).toMatchObject({
      content: "ship",
      status: "in_progress",
      originalStatus: "in_progress",
      priority: "high",
    })
  })

  it("records instruction files as partial, since contents are not exposed", () => {
    const events = normalizeHook({
      host: "claude",
      event: "InstructionsLoaded",
      deliveryId: "d",
      payload: { session_id: "s", file_path: "/repo/CLAUDE.md", memory_type: "Project", load_reason: "session_start" },
    })
    expect(find(events, "prompt.fragment")).toMatchObject({
      promptKind: "instructions",
      path: "/repo/CLAUDE.md",
      availability: "partial",
    })
  })
})

describe("codex adapter", () => {
  it("uses the model present on every hook payload", () => {
    const events = normalizeHook({
      host: "codex",
      event: "SessionStart",
      deliveryId: "d",
      payload: { session_id: "s", source: "startup", model: "gpt-5.3-codex" },
    })
    expect(find(events, "agent.model")).toMatchObject({ model: "gpt-5.3-codex", confidence: "authoritative" })
  })

  it("emits final assistant text from Stop", () => {
    const events = normalizeHook({
      host: "codex",
      event: "Stop",
      deliveryId: "d",
      payload: { session_id: "s", turn_id: "t1", last_assistant_message: "all done" },
    })
    expect(find(events, "message.assistant")).toMatchObject({ text: "all done", final: true })
  })

  it("converts update_plan into the todo list", () => {
    const events = normalizeHook({
      host: "codex",
      event: "PostToolUse",
      deliveryId: "d",
      payload: {
        session_id: "s",
        tool_name: "update_plan",
        tool_use_id: "t1",
        tool_input: { plan: [{ step: "one", status: "completed" }, { step: "two", status: "in_progress" }] },
        tool_response: {},
      },
    })
    expect(find(events, "plan.updated")?.steps).toEqual([
      { step: "one", status: "completed", originalStatus: "completed" },
      { step: "two", status: "in_progress", originalStatus: "in_progress" },
    ])
  })

  it("reconciles Codex collaboration paths, nested parents, and direct messages", () => {
    const hook = (event: string, payload: Record<string, unknown>, deliveryId: string) =>
      normalizeHook({
        host: "codex",
        event,
        deliveryId,
        payload: { session_id: "codex-collaboration-s", ...payload },
      })

    hook(
      "PreToolUse",
      {
        tool_name: "collaborationspawn_agent",
        tool_use_id: "spawn-reviewer",
        tool_input: { task_name: "reviewer", message: "Review correctness" },
      },
      "collab-1",
    )
    hook(
      "PostToolUse",
      {
        tool_name: "collaborationspawn_agent",
        tool_use_id: "spawn-reviewer",
        tool_input: { task_name: "reviewer", message: "Review correctness" },
        tool_response: { task_name: "/root/reviewer" },
      },
      "collab-2",
    )
    const reviewer = hook(
      "SubagentStart",
      { agent_id: "reviewer-id", agent_type: "reviewer", model: "gpt-5.6-sol" },
      "collab-3",
    )

    expect(reviewer[0]?.agentKey).toBe("agent:reviewer-id")
    expect(reviewer[0]?.provenance).toBe("reconciled")
    expect(reviewer[0]?.body).toMatchObject({
      kind: "agent.started",
      parentAgentKey: "main",
      displayName: "/root/reviewer",
      prompt: "Review correctness",
    })

    hook(
      "PreToolUse",
      {
        agent_id: "reviewer-id",
        tool_name: "collaborationspawn_agent",
        tool_use_id: "spawn-tests",
        tool_input: { task_name: "tests", message: "Check the tests" },
      },
      "collab-4",
    )
    hook(
      "PostToolUse",
      {
        agent_id: "reviewer-id",
        tool_name: "collaborationspawn_agent",
        tool_use_id: "spawn-tests",
        tool_input: { task_name: "tests", message: "Check the tests" },
        tool_response: { task_name: "/root/reviewer/tests" },
      },
      "collab-5",
    )
    const tests = hook(
      "SubagentStart",
      { agent_id: "tests-id", agent_type: "reviewer", model: "gpt-5.6-sol" },
      "collab-6",
    )

    expect(tests[0]?.body).toMatchObject({
      kind: "agent.started",
      parentAgentKey: "agent:reviewer-id",
      displayName: "/root/reviewer/tests",
    })

    const message = hook(
      "PreToolUse",
      {
        agent_id: "tests-id",
        tool_name: "collaborationsend_message",
        tool_use_id: "message-reviewer",
        tool_input: { target: "/root/reviewer", message: "Tests are clean" },
      },
      "collab-7",
    )
    expect(find(message, "edge.observed")).toEqual({
      kind: "edge.observed",
      fromAgentKey: "agent:tests-id",
      toAgentKey: "agent:reviewer-id",
      edgeType: "messaged",
      label: "direct message",
    })
  })

  it("falls back to the root when a Codex subagent has no matching spawn event", () => {
    const events = normalizeHook({
      host: "codex",
      event: "SubagentStart",
      deliveryId: "d",
      payload: { session_id: "unmatched-s", agent_id: "a1", agent_type: "reviewer", model: "gpt-5.3-codex" },
    })
    expect(events[0]?.agentKey).toBe("agent:a1")
    expect(events[0]?.body).toMatchObject({ parentAgentKey: "main", agentType: "reviewer" })
  })
})

describe("copilot adapter", () => {
  it("accepts VS Code style PascalCase event names", () => {
    const events = normalizeHook({
      host: "copilot",
      event: "SessionStart",
      deliveryId: "d",
      payload: { sessionId: "s", source: "startup", cwd: "/repo" },
    })
    expect(kinds(events)).toContain("session.started")
  })

  // Copilot states the opening prompt twice — once on sessionStart, once on
  // userPromptSubmitted — with different timestamps and identical text. Neither
  // hook may draw a message, or every session opens with a duplicated turn.
  it("draws no user message from either hook that carries the opening prompt", () => {
    const start = normalizeHook({
      host: "copilot",
      event: "sessionStart",
      deliveryId: "d1",
      payload: { sessionId: "s", source: "new", initialPrompt: "fix the bug", timestamp: 1000 },
    })
    const submitted = normalizeHook({
      host: "copilot",
      event: "userPromptSubmitted",
      deliveryId: "d2",
      payload: { sessionId: "s", prompt: "fix the bug", timestamp: 1200 },
    })
    expect(kinds(start)).not.toContain("message.user")
    expect(kinds(submitted)).not.toContain("message.user")
    expect(kinds(submitted)).toContain("session.status")
  })

  it("synthesises a stable tool call id from name and arguments", () => {
    const pre = normalizeHook({
      host: "copilot",
      event: "preToolUse",
      deliveryId: "d1",
      payload: { sessionId: "s", toolName: "bash", toolArgs: { command: "ls" } },
    })
    const post = normalizeHook({
      host: "copilot",
      event: "postToolUse",
      deliveryId: "d2",
      payload: {
        sessionId: "s",
        toolName: "bash",
        toolArgs: { command: "ls" },
        toolResult: { resultType: "success", textResultForLlm: "a b" },
      },
    })
    const started = find(pre, "tool.started")
    const finished = find(post, "tool.finished")
    expect(started?.callId).toBe(finished?.callId)
    expect(finished?.output).toBe("a b")
  })

  it("keys subagents by name so start and stop reach the same node", () => {
    const start = normalizeHook({
      host: "copilot",
      event: "subagentStart",
      deliveryId: "d1",
      payload: { sessionId: "s", agentName: "reviewer", agentDisplayName: "Reviewer" },
    })
    const stop = normalizeHook({
      host: "copilot",
      event: "subagentStop",
      deliveryId: "d2",
      payload: { sessionId: "s", agentName: "reviewer", agentId: "real-1", response: "looks good" },
    })
    expect(start[0]?.agentKey).toBe("sub:reviewer")
    expect(stop.every((event) => event.agentKey === "sub:reviewer")).toBe(true)
    expect(find(stop, "message.assistant")).toMatchObject({ text: "looks good" })
  })
})

describe("opencode adapter", () => {
  const context = { sessionKey: "root", agentKey: "main", at: 5 }

  it("requires the plugin-supplied root session key", () => {
    expect(normalizeHook({ host: "opencode", event: "session.idle", payload: {}, deliveryId: "d" })).toEqual([])
  })

  it("inherits the root session title reported by OpenCode", () => {
    const events = normalizeHook({
      host: "opencode",
      event: "session.created",
      deliveryId: "d",
      payload: { info: { id: "root", title: "Review the observer canvas", directory: "/repo" } },
      context,
    })

    expect(find(events, "session.started")).toMatchObject({ title: "Review the observer canvas" })
  })

  it("turns a child session into an agent node under its parent", () => {
    const events = normalizeHook({
      host: "opencode",
      event: "session.created",
      deliveryId: "d",
      payload: { info: { id: "child", parentID: "root", title: "search the repo" } },
      context: { sessionKey: "root", agentKey: "session:child", parentAgentKey: "main", prompt: "find things" },
    })
    expect(events[0]?.body).toMatchObject({
      kind: "agent.started",
      runtimeId: "child",
      parentAgentKey: "main",
      description: "search the repo",
      prompt: "find things",
    })
  })

  it("marks an assignment continuation as a resume", () => {
    const events = normalizeHook({
      host: "opencode",
      event: "observer.assignment",
      deliveryId: "d",
      payload: { status: "running" },
      context: {
        sessionKey: "root",
        agentKey: "session:child",
        parentAgentKey: "main",
        runtimeId: "child",
        agentType: "malik-johnson",
        resumed: true,
      },
    })
    expect(find(events, "agent.started")).toMatchObject({ runtimeId: "child", resumed: true })
  })

  it("streams assistant text deltas", () => {
    const events = normalizeHook({
      host: "opencode",
      event: "message.part.updated",
      deliveryId: "d",
      payload: { part: { type: "text", messageID: "m1", sessionID: "root", text: "abc" }, delta: "c" },
      context: { ...context, role: "assistant" },
    })
    expect(find(events, "message.assistant.delta")).toMatchObject({ delta: "c", messageKey: "m1" })
  })

  it("does not misfile user text as assistant output", () => {
    const events = normalizeHook({
      host: "opencode",
      event: "message.part.updated",
      deliveryId: "d",
      payload: { part: { type: "text", messageID: "m1", sessionID: "root", text: "hi" } },
      context: { ...context, role: "user" },
    })
    expect(kinds(events)).toEqual(["message.user"])
  })

  it("captures the composed system prompt exposed by the plugin", () => {
    const events = normalizeHook({
      host: "opencode",
      event: "observer.system",
      deliveryId: "d",
      payload: { system: ["You are a coding agent", "Project rules"] },
      context,
    })
    expect(events).toHaveLength(2)
    expect(events[0]?.body).toMatchObject({ kind: "prompt.fragment", promptKind: "system", availability: "available" })
  })

  it("lands the plugin's end-of-delegation signal on the subagent node", () => {
    // Emitted with the child session's resolution, so it must keep it.
    const events = normalizeHook({
      host: "opencode",
      event: "observer.agent-status",
      deliveryId: "d",
      payload: { status: "completed" },
      context: { ...context, agentKey: "session:child", parentAgentKey: "main" },
    })
    expect(events[0]?.agentKey).toBe("session:child")
    expect(find(events, "agent.status")).toMatchObject({ status: "completed" })

    const failed = normalizeHook({
      host: "opencode",
      event: "observer.agent-status",
      deliveryId: "d",
      payload: { status: "failed" },
      context,
    })
    expect(find(failed, "agent.status")).toMatchObject({ status: "failed" })
  })

  it("treats an out-of-contract status as unmapped rather than inventing a state", () => {
    // The plugin only ever sends completed or failed; anything else is drift
    // between the two ends and must surface as a gap, not as a drawn state.
    const events = normalizeHook({
      host: "opencode",
      event: "observer.agent-status",
      deliveryId: "d",
      payload: { status: "running" },
      context,
    })
    expect(events).toEqual([])
  })

  it("never throws on malformed payloads", () => {
    expect(() =>
      normalizeHook({
        host: "opencode",
        event: "message.part.updated",
        deliveryId: "d",
        payload: { part: null },
        context,
      }),
    ).not.toThrow()
  })
})

describe("adapter ignore list", () => {
  const context = { sessionKey: "root", agentKey: "main", at: 5 }

  function partUpdate(type: unknown, event = "message.part.updated"): Parameters<typeof ignoresHook>[0] {
    return {
      host: "opencode",
      event,
      deliveryId: "d",
      payload: { part: { type, id: "prt", messageID: "m1" } },
      context,
    }
  }

  it("declares OpenCode step parts as deliberately undrawn", () => {
    // These outnumber the parts Observer draws several to one, so counting them
    // as faults is what put a five-figure alarm in front of the user.
    expect(ignoresHook(partUpdate("step-start"))).toBe(true)
    expect(ignoresHook(partUpdate("step-finish"))).toBe(true)
    expect(ignoresHook(partUpdate("patch"))).toBe(true)
    expect(normalizeHook(partUpdate("step-start"))).toEqual([])
  })

  it("does not claim a part type it has never heard of", () => {
    // The allowlist must never become a catch-all: an unknown type is how
    // Observer learns OpenCode shipped something new worth drawing.
    expect(ignoresHook(partUpdate("quantum-flux"))).toBe(false)
    expect(ignoresHook(partUpdate(undefined))).toBe(false)
  })

  it("does not claim a part type Observer actually draws", () => {
    expect(ignoresHook(partUpdate("text"))).toBe(false)
    expect(ignoresHook(partUpdate("tool"))).toBe(false)
  })

  it("is scoped to the event that carries parts", () => {
    // A `part` key on some other event is not the same delivery shape, and
    // silencing it would hide a real gap in that event's coverage.
    expect(ignoresHook(partUpdate("step-start", "session.updated"))).toBe(false)
  })

  it("answers false for hosts with no opinion, and never throws", () => {
    const noOpinion = { host: "claude" as const, event: "SomeFutureEvent", deliveryId: "d", payload: {} }
    const broken = { host: "opencode" as const, event: "message.part.updated", deliveryId: "d", payload: null }
    expect(ignoresHook(noOpinion)).toBe(false)
    expect(() => ignoresHook(broken)).not.toThrow()
    expect(ignoresHook(broken)).toBe(false)
  })
})

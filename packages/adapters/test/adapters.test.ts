import { describe, expect, it } from "vitest"
import { normalizeHook } from "@observer-ai/adapters"
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

  it("attaches subagents to the session's main agent", () => {
    const events = normalizeHook({
      host: "codex",
      event: "SubagentStart",
      deliveryId: "d",
      payload: { session_id: "s", agent_id: "a1", agent_type: "reviewer", model: "gpt-5.3-codex" },
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
      parentAgentKey: "main",
      description: "search the repo",
      prompt: "find things",
    })
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

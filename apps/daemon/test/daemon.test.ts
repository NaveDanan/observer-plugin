import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Store } from "@observer-ai/storage"
import type { Change } from "@observer-ai/protocol"
import { Broadcaster, DEFAULT_CONFIG, Pipeline, createServer } from "@observer-ai/daemon"
import type { ObserverConfig } from "@observer-ai/daemon"

function makeConfig(overrides: Partial<ObserverConfig> = {}): ObserverConfig {
  return {
    ...DEFAULT_CONFIG,
    token: "test-token",
    ...overrides,
    capture: { ...DEFAULT_CONFIG.capture, ...(overrides.capture ?? {}) },
    redaction: { ...DEFAULT_CONFIG.redaction, ...(overrides.redaction ?? {}) },
  }
}

function setup(config = makeConfig()): { store: Store; pipeline: Pipeline; changes: Change[] } {
  const store = new Store({ path: ":memory:" })
  const changes: Change[] = []
  const pipeline = new Pipeline({ store, config, onChanges: (batch) => changes.push(...batch) })
  return { store, pipeline, changes }
}

const closers: Array<() => void> = []
afterEach(() => {
  while (closers.length > 0) closers.pop()?.()
})

describe("Pipeline", () => {
  it("ingests a hook and projects entities", () => {
    const { store, pipeline, changes } = setup()
    closers.push(() => store.close())

    const result = pipeline.ingestHook({
      host: "claude",
      event: "SessionStart",
      deliveryId: "d1",
      workspaceRoot: "/repo",
      payload: { session_id: "s1", source: "startup", model: "claude-opus-5" },
    })

    expect(result.accepted).toBe(1)
    expect(store.listSessions()[0]?.model).toBe("claude-opus-5")
    expect(changes.some((change) => change.table === "session")).toBe(true)
  })

  it("treats a replayed delivery as a duplicate", () => {
    const { store, pipeline } = setup()
    closers.push(() => store.close())
    const delivery = {
      host: "claude" as const,
      event: "UserPromptSubmit",
      deliveryId: "same",
      payload: { session_id: "s1", prompt: "hi", prompt_id: "p1" },
    }

    expect(pipeline.ingestHook(delivery).accepted).toBeGreaterThan(0)
    expect(pipeline.ingestHook(delivery).accepted).toBe(0)
    expect(pipeline.ingestHook(delivery).duplicates).toBeGreaterThan(0)
  })

  it("ignores hook events it does not understand", () => {
    const { store, pipeline } = setup()
    closers.push(() => store.close())
    expect(pipeline.ingestHook({ host: "claude", event: "Nonsense", deliveryId: "d", payload: {} }).accepted).toBe(0)
  })

  it("redacts secrets before they reach the database", () => {
    const { store, pipeline } = setup()
    closers.push(() => store.close())

    pipeline.ingestHook({
      host: "claude",
      event: "UserPromptSubmit",
      deliveryId: "d",
      payload: { session_id: "s1", prompt_id: "p1", prompt: "deploy with ghp_abcdefghijklmnopqrstuvwxyz0123" },
    })

    const agents = store.listAgents("claude:s1")
    const messages = store.listMessages(agents[0]!.id)
    expect(messages[0]?.text).toBe("deploy with [redacted]")
  })

  it("drops message content entirely when capture is disabled", () => {
    const config = makeConfig({ capture: { ...DEFAULT_CONFIG.capture, messages: false } })
    const { store, pipeline } = setup(config)
    closers.push(() => store.close())

    pipeline.ingestHook({
      host: "claude",
      event: "UserPromptSubmit",
      deliveryId: "d",
      payload: { session_id: "s1", prompt_id: "p1", prompt: "private" },
    })

    const agents = store.listAgents("claude:s1")
    expect(agents.length > 0 ? store.listMessages(agents[0]!.id) : []).toHaveLength(0)
  })

  it("omits tool output when that capture switch is off", () => {
    const config = makeConfig({ capture: { ...DEFAULT_CONFIG.capture, toolOutput: false } })
    const { store, pipeline } = setup(config)
    closers.push(() => store.close())

    pipeline.ingestHook({
      host: "claude",
      event: "PostToolUse",
      deliveryId: "d",
      payload: { session_id: "s1", tool_name: "Bash", tool_use_id: "t1", tool_input: {}, tool_response: "secret" },
    })

    const agent = store.listAgents("claude:s1")[0]!
    expect(store.listToolCalls(agent.id)[0]?.output).toBeNull()
  })

  // Churn is derived from tool arguments, and capture policy rewrites those
  // arguments before the reducer ever sees them. These go through the whole
  // Pipeline for that reason: a reducer-only test cannot see the substitution.
  function edit(pipeline: Pipeline, deliveryId: string, callId: string, input: unknown): void {
    pipeline.ingestHook({
      host: "claude",
      event: "PreToolUse",
      deliveryId: `${deliveryId}-pre`,
      payload: { session_id: "s1", tool_name: "Edit", tool_use_id: callId, tool_input: input },
    })
    pipeline.ingestHook({
      host: "claude",
      event: "PostToolUse",
      deliveryId: `${deliveryId}-post`,
      payload: { session_id: "s1", tool_name: "Edit", tool_use_id: callId, tool_input: input, tool_response: "done" },
    })
  }

  it("counts churn end to end for an ordinary edit", () => {
    const { store, pipeline } = setup()
    closers.push(() => store.close())

    edit(pipeline, "d1", "t1", { file_path: "/a.ts", old_string: "one\ntwo", new_string: "1\n2\n3" })

    const agent = store.listAgents("claude:s1")[0]!
    expect(store.getAgent(agent.id)?.linesAdded).toBe(3)
    expect(store.getAgent(agent.id)?.linesRemoved).toBe(2)
    expect(store.getAgent(agent.id)?.churnConfidence).toBe("inferred")
  })

  it("does not count lines the redactor put there", () => {
    const { store, pipeline } = setup()
    closers.push(() => store.close())

    // A secret inside the replacement text. `redactValue` substitutes
    // "[redacted]" for it, so counting the stored string would be counting the
    // redactor's output rather than the file's.
    edit(pipeline, "d1", "t1", {
      file_path: "/a.ts",
      old_string: "one\ntwo",
      new_string: "token = ghp_abcdefghijklmnopqrstuvwxyz0123\nnext",
    })

    const agent = store.listAgents("claude:s1")[0]!
    const stored = store.listToolCalls(agent.id)[0]!
    expect(JSON.stringify(stored.input)).toContain("[redacted]")
    // The rewritten side is withheld; the untouched side is still counted.
    expect(store.getAgent(agent.id)?.linesAdded).toBeUndefined()
    expect(store.getAgent(agent.id)?.linesRemoved).toBe(2)
  })

  it("does not count a truncated argument as a line count", () => {
    const config = makeConfig({ redaction: { ...DEFAULT_CONFIG.redaction, maxTextLength: 40 } })
    const { store, pipeline } = setup(config)
    closers.push(() => store.close())

    const content = Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n")
    pipeline.ingestHook({
      host: "claude",
      event: "PreToolUse",
      deliveryId: "d1-pre",
      payload: { session_id: "s1", tool_name: "Write", tool_use_id: "t1", tool_input: { content } },
    })
    pipeline.ingestHook({
      host: "claude",
      event: "PostToolUse",
      deliveryId: "d1-post",
      payload: { session_id: "s1", tool_name: "Write", tool_use_id: "t1", tool_response: "ok" },
    })

    const agent = store.listAgents("claude:s1")[0]!
    expect(JSON.stringify(store.listToolCalls(agent.id)[0]?.input)).toContain("truncated")
    // 40 characters of a 50-line file is not 50 lines, and it is not 3 either.
    expect(store.getAgent(agent.id)?.linesAdded).toBeUndefined()
  })

  it("counts no churn at all when tool input capture is off", () => {
    const config = makeConfig({ capture: { ...DEFAULT_CONFIG.capture, toolInput: false } })
    const { store, pipeline } = setup(config)
    closers.push(() => store.close())

    edit(pipeline, "d1", "t1", { old_string: "one\ntwo", new_string: "1\n2\n3" })

    const agent = store.listAgents("claude:s1")[0]!
    expect(store.getAgent(agent.id)?.linesAdded).toBeUndefined()
    expect(store.getAgent(agent.id)?.linesRemoved).toBeUndefined()
  })

  it("survives the same delivery arriving twice through the pipeline", () => {
    const { store, pipeline } = setup()
    closers.push(() => store.close())

    const input = { old_string: "a\nb\nc", new_string: "x" }
    edit(pipeline, "d1", "t1", input)
    // Identical delivery ids: the event log rejects these as duplicates.
    edit(pipeline, "d1", "t1", input)
    // Fresh delivery ids carrying the same call id: these reach the reducer.
    edit(pipeline, "d2", "t1", input)

    const agent = store.listAgents("claude:s1")[0]!
    expect(store.getAgent(agent.id)?.linesAdded).toBe(1)
    expect(store.getAgent(agent.id)?.linesRemoved).toBe(3)
  })
})

describe("Broadcaster", () => {
  it("replays buffered changes to a reconnecting client", () => {
    const broadcaster = new Broadcaster(10)
    const change: Change = { table: "todo", op: "delete", id: "x" }
    broadcaster.publish([change])
    broadcaster.publish([change])

    const received: string[] = []
    const ok = broadcaster.replay({ send: (data) => received.push(data), close: () => undefined }, 1)

    expect(ok).toBe(true)
    expect(received).toHaveLength(1)
    expect(JSON.parse(received[0]!).cursor).toBe(2)
  })

  it("asks for a full resync when the gap exceeds the buffer", () => {
    const broadcaster = new Broadcaster(2)
    for (let i = 0; i < 5; i++) broadcaster.publish([{ table: "todo", op: "delete", id: String(i) }])

    const ok = broadcaster.replay({ send: () => undefined, close: () => undefined }, 1)
    expect(ok).toBe(false)
  })

  it("drops clients whose socket throws", () => {
    const broadcaster = new Broadcaster()
    broadcaster.add({
      send: () => {
        throw new Error("closed")
      },
      close: () => undefined,
    })
    broadcaster.publish([{ table: "todo", op: "delete", id: "x" }])
    expect(broadcaster.size).toBe(0)
  })
})

describe("HTTP API", () => {
  it("rejects unauthenticated requests and serves data with a token", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const broadcaster = new Broadcaster()
    const app = await createServer({ store, pipeline, config, broadcaster, webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })

    const unauthorized = await app.inject({ method: "GET", url: "/v1/sessions" })
    expect(unauthorized.statusCode).toBe(401)

    const hook = await app.inject({
      method: "POST",
      url: "/v1/hook",
      headers: { authorization: `Bearer ${config.token}` },
      payload: {
        host: "codex",
        event: "SessionStart",
        deliveryId: "d1",
        workspaceRoot: "/repo",
        payload: { session_id: "s1", model: "gpt-5.3-codex" },
      },
    })
    expect(hook.statusCode).toBe(200)

    const sessions = await app.inject({
      method: "GET",
      url: "/v1/sessions",
      headers: { authorization: `Bearer ${config.token}` },
    })
    expect(sessions.json().sessions[0].model).toBe("gpt-5.3-codex")

    const snapshot = await app.inject({
      method: "GET",
      url: `/v1/sessions/${encodeURIComponent("codex:s1")}`,
      headers: { authorization: `Bearer ${config.token}` },
    })
    expect(snapshot.json().agents).toHaveLength(1)
  })

  it("serves an attachment by id and refuses one it never minted", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const broadcaster = new Broadcaster()
    const app = await createServer({ store, pipeline, config, broadcaster, webDir: "/nonexistent" })
    const dir = mkdtempSync(join(tmpdir(), "observer-attachment-"))
    const file = join(dir, "shot.png")
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const svg = join(dir, "diagram.svg")
    writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")
    closers.push(() => {
      void app.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    })

    pipeline.ingestEvents([
      {
        host: "copilot",
        adapter: "copilot-session-log@1",
        workspaceRoot: "/repo",
        sessionKey: "s1",
        agentKey: "main",
        at: Date.now(),
        provenance: "reconciled",
        body: {
          kind: "message.user",
          messageKey: "u1",
          text: "look",
          attachments: [
            { id: "att-1", name: "shot.png", path: file, mimeType: "image/png" },
            { id: "att-2", name: "diagram.svg", path: svg, mimeType: "image/svg+xml" },
          ],
        },
      },
    ])

    const headers = { authorization: `Bearer ${config.token}` }
    const served = await app.inject({ method: "GET", url: "/v1/attachments/att-1", headers })
    expect(served.statusCode).toBe(200)
    expect(served.headers["content-type"]).toBe("image/png")
    expect(served.headers["x-content-type-options"]).toBe("nosniff")
    expect(served.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    // An SVG is a document, not a picture: it is never served as one from our origin.
    const svgServed = await app.inject({ method: "GET", url: "/v1/attachments/att-2", headers })
    expect(svgServed.statusCode).toBe(200)
    expect(svgServed.headers["content-type"]).toBe("application/octet-stream")
    expect(svgServed.headers["content-disposition"]).toBe('attachment; filename="diagram.svg"')
    expect(svgServed.headers["x-content-type-options"]).toBe("nosniff")

    // No message names this id, so there is no path to ask for.
    const unknown = await app.inject({ method: "GET", url: "/v1/attachments/att-9", headers })
    expect(unknown.statusCode).toBe(404)

    // And a path is never accepted as an identifier.
    const byPath = await app.inject({
      method: "GET",
      url: `/v1/attachments/${encodeURIComponent(file)}`,
      headers,
    })
    expect(byPath.statusCode).toBe(404)

    rmSync(file)
    const gone = await app.inject({ method: "GET", url: "/v1/attachments/att-1", headers })
    expect(gone.statusCode).toBe(410)
  })

  it("blocks requests with a foreign Host header", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const broadcaster = new Broadcaster()
    const app = await createServer({ store, pipeline, config, broadcaster, webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })

    const response = await app.inject({ method: "GET", url: "/health", headers: { host: "evil.example.com" } })
    expect(response.statusCode).toBe(403)
  })

  it("exposes host capabilities so the UI can state its limits", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const broadcaster = new Broadcaster()
    const app = await createServer({ store, pipeline, config, broadcaster, webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })

    const body = (await app.inject({ method: "GET", url: "/v1/bootstrap" })).json()
    expect(body.token).toBe(config.token)
    expect(body.hosts.map((host: { host: string }) => host.host).sort()).toEqual([
      "claude",
      "codex",
      "copilot",
      "opencode",
    ])
  })

  it("persists stable assignments and delivers direct peer mail", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const broadcaster = new Broadcaster()
    const app = await createServer({ store, pipeline, config, broadcaster, webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })
    const headers = { authorization: `Bearer ${config.token}` }
    const assignment = (id: string, callId: string) => ({
      id: `assignment-${id}`,
      host: "opencode",
      rootSessionKey: "root",
      runtimeId: id,
      parentRuntimeId: "root",
      callId,
      agentType: "malik-johnson",
      hostAgentType: "general",
      description: `Agent ${id}`,
      prompt: `Prompt ${id}`,
      status: "running",
    })
    for (const value of [assignment("a", "call-a"), { ...assignment("b", "call-b"), parentRuntimeId: "a" }]) {
      const response = await app.inject({ method: "POST", url: "/v1/coordination/assignments", headers, payload: value })
      expect(response.statusCode, response.body).toBe(200)
    }
    const initialEvents = store.countEvents()
    const replayedAssignment = await app.inject({
      method: "POST",
      url: "/v1/coordination/assignments",
      headers,
      payload: assignment("a", "call-a"),
    })
    expect(replayedAssignment.json().assignment.id).toBe("assignment-a")
    expect(store.listAgentAssignments("opencode", "root")).toHaveLength(2)
    expect(store.countEvents()).toBe(initialEvents)
    const completed = { ...assignment("a", "call-a"), status: "completed" }
    const completedResponse = await app.inject({ method: "POST", url: "/v1/coordination/assignments", headers, payload: completed })
    expect(completedResponse.json().assignment.status).toBe("completed")
    const lateReplay = await app.inject({ method: "POST", url: "/v1/coordination/assignments", headers, payload: assignment("a", "call-a") })
    expect(lateReplay.json().assignment.status).toBe("completed")
    expect(store.getAgentAssignment("assignment-a")?.status).toBe("completed")
    await app.inject({
      method: "POST",
      url: "/v1/coordination/assignments",
      headers,
      payload: { ...assignment("a", "call-a"), resumed: true },
    })
    expect(store.getAgentAssignment("assignment-a")?.status).toBe("running")

    const sent = await app.inject({
      method: "POST",
      url: "/v1/coordination/mail",
      headers,
      payload: {
        id: "mail-1",
        host: "opencode",
        rootSessionKey: "root",
        fromRuntimeId: "a",
        toRuntimeId: "b",
        text: "Review the migration",
      },
    })
    expect(sent.statusCode).toBe(200)

    const inbox = await app.inject({
      method: "GET",
      url: "/v1/coordination/mail?host=opencode&rootSessionKey=root&runtimeId=b",
      headers,
    })
    expect(inbox.json().messages).toEqual([
      expect.objectContaining({ id: "mail-1", fromRuntimeId: "a", toRuntimeId: "b" }),
    ])
    const ack = await app.inject({
      method: "POST",
      url: "/v1/coordination/mail/read",
      headers,
      payload: { host: "opencode", rootSessionKey: "root", runtimeId: "b", ids: ["mail-1"] },
    })
    expect(ack.statusCode).toBe(200)
    const emptyInbox = await app.inject({
      method: "GET",
      url: "/v1/coordination/mail?host=opencode&rootSessionKey=root&runtimeId=b",
      headers,
    })
    expect(emptyInbox.json().messages).toEqual([])
    expect(store.listEdges("opencode:root")).toContainEqual(
      expect.objectContaining({ edgeType: "messaged", fromAgentId: "opencode:root~session:a", toAgentId: "opencode:root~session:b" }),
    )
  })

  it("rejects every subagent assignment without an explicit parent runtime id", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const app = await createServer({ store, pipeline, config, broadcaster: new Broadcaster(), webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })
    const response = await app.inject({
      method: "POST",
      url: "/v1/coordination/assignments",
      headers: { authorization: `Bearer ${config.token}` },
      payload: {
        id: "assignment-orphan",
        host: "opencode",
        rootSessionKey: "root",
        runtimeId: "orphan",
        agentType: "subcontractor",
        hostAgentType: "general",
        status: "running",
      },
    })

    expect(response.statusCode, response.body).toBe(400)
    expect(store.getAgentAssignment("assignment-orphan")).toBeUndefined()
    expect(store.getAgent("opencode:root~session:orphan")).toBeUndefined()
  })

  it("enforces two subagent levels at the coordination boundary", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const app = await createServer({ store, pipeline, config, broadcaster: new Broadcaster(), webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })
    const headers = { authorization: `Bearer ${config.token}` }
    const assignment = (id: string, parentRuntimeId: string) => ({
      id: `assignment-${id}`,
      host: "opencode",
      rootSessionKey: "root",
      runtimeId: id,
      parentRuntimeId,
      callId: `call-${id}`,
      agentType: "subcontractor",
      hostAgentType: "general",
      status: "running",
    })

    expect((await app.inject({ method: "POST", url: "/v1/coordination/assignments", headers, payload: assignment("level-1", "root") })).statusCode).toBe(200)
    expect((await app.inject({ method: "POST", url: "/v1/coordination/assignments", headers, payload: assignment("level-2", "level-1") })).statusCode).toBe(200)
    const tooDeep = await app.inject({
      method: "POST",
      url: "/v1/coordination/assignments",
      headers,
      payload: assignment("level-3", "level-2"),
    })

    expect(tooDeep.statusCode).toBe(409)
    expect(tooDeep.json().error).toContain("depth limit reached (3 session levels)")
    expect(store.getAgentAssignment("assignment-level-3")).toBeUndefined()
    expect(store.getAgent("opencode:root~session:level-3")).toBeUndefined()
  })

  it("admits only one top-level OpenCode coordinator per root session", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const app = await createServer({ store, pipeline, config, broadcaster: new Broadcaster(), webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })
    const headers = { authorization: `Bearer ${config.token}` }
    const assignment = (id: string) => ({
      id: `assignment-${id}`,
      host: "opencode",
      rootSessionKey: "root",
      runtimeId: id,
      parentRuntimeId: "root",
      agentType: "subcontractor",
      hostAgentType: "general",
      status: "running",
    })

    expect((await app.inject({ method: "POST", url: "/v1/coordination/assignments", headers, payload: assignment("coordinator") })).statusCode).toBe(200)
    const second = await app.inject({
      method: "POST",
      url: "/v1/coordination/assignments",
      headers,
      payload: assignment("second-root-child"),
    })

    expect(second.statusCode).toBe(409)
    expect(second.json().error).toBe(
      "root coordinator already exists (task_id coordinator); resume it and use agent_spawn for additional workers",
    )
    expect(store.listAgentAssignments("opencode", "root")).toHaveLength(1)
  })

  it("never persists more than 15 subagents for one root session", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const app = await createServer({ store, pipeline, config, broadcaster: new Broadcaster(), webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })
    const headers = { authorization: `Bearer ${config.token}` }
    const assignment = (index: number) => ({
      id: `assignment-${index}`,
      host: "opencode",
      rootSessionKey: "root",
      runtimeId: `child-${index}`,
      parentRuntimeId: index === 0 ? "root" : "child-0",
      callId: `call-${index}`,
      agentType: "subcontractor",
      hostAgentType: "general",
      status: index % 2 === 0 ? "completed" : "running",
    })

    for (let index = 0; index < 15; index++) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/coordination/assignments",
        headers,
        payload: assignment(index),
      })
      expect(response.statusCode, response.body).toBe(200)
    }
    const sixteenth = await app.inject({
      method: "POST",
      url: "/v1/coordination/assignments",
      headers,
      payload: assignment(15),
    })

    expect(sixteenth.statusCode).toBe(409)
    expect(sixteenth.json().error).toBe("subagent limit reached (15 per session)")
    expect(store.listAgentAssignments("opencode", "root")).toHaveLength(15)
    expect(store.getAgentAssignment("assignment-15")).toBeUndefined()
    expect(store.getAgent("opencode:root~session:child-15")).toBeUndefined()

    const resumed = await app.inject({
      method: "POST",
      url: "/v1/coordination/assignments",
      headers,
      payload: { ...assignment(0), status: "running", resumed: true },
    })
    expect(resumed.statusCode, resumed.body).toBe(200)
    expect(store.listAgentAssignments("opencode", "root")).toHaveLength(15)
  })

  it("holds the 15-subagent cap across parallel coordination requests", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const app = await createServer({ store, pipeline, config, broadcaster: new Broadcaster(), webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })
    const headers = { authorization: `Bearer ${config.token}` }
    const coordinator = {
      id: "parallel-coordinator",
      host: "opencode",
      rootSessionKey: "parallel-root",
      runtimeId: "parallel-coordinator",
      parentRuntimeId: "parallel-root",
      agentType: "subcontractor",
      hostAgentType: "general",
      status: "running",
    }
    expect(
      (await app.inject({ method: "POST", url: "/v1/coordination/assignments", headers, payload: coordinator })).statusCode,
    ).toBe(200)
    const responses = await Promise.all(
      Array.from({ length: 15 }, (_, index) =>
        app.inject({
          method: "POST",
          url: "/v1/coordination/assignments",
          headers,
          payload: {
            id: `parallel-${index}`,
            host: "opencode",
            rootSessionKey: "parallel-root",
            runtimeId: `parallel-child-${index}`,
            parentRuntimeId: "parallel-coordinator",
            agentType: "subcontractor",
            hostAgentType: "general",
            status: "running",
          },
        }),
      ),
    )

    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(14)
    expect(responses.filter((response) => response.statusCode === 409)).toHaveLength(1)
    expect(store.listAgentAssignments("opencode", "parallel-root")).toHaveLength(15)
  })

  it("cannot reparent an existing assignment to bypass depth enforcement", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const app = await createServer({ store, pipeline, config, broadcaster: new Broadcaster(), webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })
    const headers = { authorization: `Bearer ${config.token}` }
    const original = {
      id: "assignment-child",
      host: "opencode",
      rootSessionKey: "root",
      runtimeId: "child",
      parentRuntimeId: "root",
      agentType: "subcontractor",
      hostAgentType: "general",
      status: "running",
    }
    expect((await app.inject({ method: "POST", url: "/v1/coordination/assignments", headers, payload: original })).statusCode).toBe(200)

    const reparented = await app.inject({
      method: "POST",
      url: "/v1/coordination/assignments",
      headers,
      payload: { ...original, parentRuntimeId: "some-other-subagent" },
    })

    expect(reparented.statusCode).toBe(409)
    expect(reparented.json().error).toBe("assignment parent cannot change")
    expect(store.getAgentAssignment("assignment-child")?.parentRuntimeId).toBe("root")
  })

  it("applies capture and redaction policy to coordination content", async () => {
    const config = makeConfig({
      capture: { ...DEFAULT_CONFIG.capture, prompts: false },
    })
    const { store, pipeline } = setup(config)
    const app = await createServer({ store, pipeline, config, broadcaster: new Broadcaster(), webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })
    const headers = { authorization: `Bearer ${config.token}` }
    const response = await app.inject({
      method: "POST",
      url: "/v1/coordination/assignments",
      headers,
      payload: {
        id: "assignment-private",
        host: "opencode",
        rootSessionKey: "root",
        runtimeId: "private",
        parentRuntimeId: "root",
        agentType: "subcontractor",
        hostAgentType: "general",
        prompt: "ghp_abcdefghijklmnopqrstuvwxyz0123",
        status: "running",
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    expect(store.getAgentAssignment("assignment-private")?.prompt).toBeNull()

    config.capture.prompts = true
    const redacted = await app.inject({
      method: "POST",
      url: "/v1/coordination/assignments",
      headers,
      payload: {
        id: "assignment-private",
        host: "opencode",
        rootSessionKey: "root",
        runtimeId: "private",
        parentRuntimeId: "root",
        agentType: "subcontractor",
        hostAgentType: "general",
        prompt: "ghp_abcdefghijklmnopqrstuvwxyz0123",
        status: "running",
      },
    })
    expect(redacted.statusCode).toBe(200)
    expect(store.getAgentAssignment("assignment-private")?.prompt).toBe("[redacted]")
  })
})

describe("Snapshot running tools", () => {
  it("reports the running tool call per agent in the snapshot", async () => {
    const config = makeConfig()
    const { store, pipeline } = setup(config)
    const broadcaster = new Broadcaster()
    const app = await createServer({ store, pipeline, config, broadcaster, webDir: "/nonexistent" })
    closers.push(() => {
      void app.close()
      store.close()
    })

    // Start a tool
    pipeline.ingestHook({
      host: "claude",
      event: "PreToolUse",
      deliveryId: "d1",
      payload: { session_id: "s1", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "sleep 10" } },
    })

    let snapshot = await app.inject({
      method: "GET",
      url: `/v1/sessions/${encodeURIComponent("claude:s1")}`,
      headers: { authorization: `Bearer ${config.token}` },
    })
    let body = snapshot.json()
    const agentId = body.agents[0].id
    expect(body.runningTools[agentId]?.tool).toBe("Bash")
    expect(body.runningTools[agentId]?.status).toBe("running")

    // Finish it
    pipeline.ingestHook({
      host: "claude",
      event: "PostToolUse",
      deliveryId: "d2",
      payload: { session_id: "s1", tool_name: "Bash", tool_use_id: "t1", tool_input: {}, tool_response: "done" },
    })

    snapshot = await app.inject({
      method: "GET",
      url: `/v1/sessions/${encodeURIComponent("claude:s1")}`,
      headers: { authorization: `Bearer ${config.token}` },
    })
    body = snapshot.json()
    expect(body.runningTools[agentId]).toBeNull()

    // Agent that never ran a tool reports null
    pipeline.ingestHook({
      host: "claude",
      event: "SubagentStart",
      deliveryId: "d3",
      payload: { session_id: "s1", agent_id: "a1", agent_type: "Explore" },
    })
    snapshot = await app.inject({
      method: "GET",
      url: `/v1/sessions/${encodeURIComponent("claude:s1")}`,
      headers: { authorization: `Bearer ${config.token}` },
    })
    body = snapshot.json()
    const subId = body.agents.find((a: { agentKey: string }) => a.agentKey === "agent:a1")?.id
    expect(body.runningTools[subId]).toBeNull()
  })
})

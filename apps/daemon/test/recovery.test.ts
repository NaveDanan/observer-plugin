import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Store } from "@observer-ai/storage"
import {
  Broadcaster,
  CopilotTailer,
  DEFAULT_CONFIG,
  Pipeline,
  SessionTitleTailer,
  drainSpool,
  encodeClaudeProjectPath,
} from "@observer-ai/daemon"

let home: string
let store: Store
let pipeline: Pipeline

const config = { ...DEFAULT_CONFIG, token: "t" }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer-test-"))
  process.env["OBSERVER_HOME"] = home
  store = new Store({ path: ":memory:" })
  pipeline = new Pipeline({ store, config, onChanges: () => undefined })
})

afterEach(() => {
  store.close()
  delete process.env["OBSERVER_HOME"]
  delete process.env["COPILOT_HOME"]
  delete process.env["CODEX_HOME"]
  delete process.env["CLAUDE_CONFIG_DIR"]
  rmSync(home, { recursive: true, force: true })
})

describe("spool recovery", () => {
  it("replays deliveries captured while the daemon was down", () => {
    mkdirSync(join(home, "spool"), { recursive: true })
    const lines = [
      JSON.stringify({
        host: "claude",
        event: "SessionStart",
        deliveryId: "d1",
        workspaceRoot: "/repo",
        payload: { session_id: "s1", model: "claude-opus-5" },
      }),
      "not json",
      JSON.stringify({ host: "nope", event: "X", deliveryId: "d2", payload: {} }),
    ]
    writeFileSync(join(home, "spool", "2026-01-01.jsonl"), `${lines.join("\n")}\n`)

    const result = drainSpool(pipeline)

    expect(result.accepted).toBe(1)
    expect(store.listSessions()[0]?.model).toBe("claude-opus-5")
  })

  it("is safe to run twice on the same data", () => {
    mkdirSync(join(home, "spool"), { recursive: true })
    const line = JSON.stringify({
      host: "claude",
      event: "SessionStart",
      deliveryId: "d1",
      workspaceRoot: "/repo",
      payload: { session_id: "s1" },
    })
    writeFileSync(join(home, "spool", "a.jsonl"), `${line}\n`)
    drainSpool(pipeline)

    // Simulate the same delivery being spooled again after a crash.
    writeFileSync(join(home, "spool", "b.jsonl"), `${line}\n`)
    const second = drainSpool(pipeline)

    expect(second.accepted).toBe(0)
    expect(second.duplicates).toBe(1)
    expect(store.listSessions()).toHaveLength(1)
  })

  it("does nothing when there is no spool directory", () => {
    expect(drainSpool(pipeline)).toEqual({ files: 0, accepted: 0, duplicates: 0 })
  })
})

describe("Copilot session log tailer", () => {
  function writeLog(sessionKey: string, lines: string[]): void {
    const dir = join(home, "copilot", "session-state", sessionKey)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "events.jsonl"), `${lines.join("\n")}\n`)
  }

  function seedSession(sessionKey: string): void {
    pipeline.ingestHook({
      host: "copilot",
      event: "sessionStart",
      deliveryId: `seed:${sessionKey}`,
      workspaceRoot: "/repo",
      payload: { sessionId: sessionKey, timestamp: Date.now() },
    })
  }

  it("recovers main-agent replies that hooks never expose", () => {
    process.env["COPILOT_HOME"] = join(home, "copilot")
    seedSession("cs1")
    writeLog("cs1", [
      JSON.stringify({
        id: "e1",
        timestamp: new Date().toISOString(),
        type: "assistant.message",
        data: { messageId: "m1", content: "Here is the fix." },
      }),
      JSON.stringify({
        id: "e2",
        timestamp: new Date().toISOString(),
        type: "assistant.usage",
        data: { model: "gpt-5.4" },
      }),
    ])

    const tailer = new CopilotTailer(store, pipeline, 10_000)
    expect(tailer.tick()).toBe(2)

    const agent = store.listAgents("copilot:cs1")[0]!
    expect(store.listMessages(agent.id)[0]?.text).toBe("Here is the fix.")
    expect(agent.model).toBe("gpt-5.4")
    expect(agent.modelConfidence).toBe("reconciled")
  })

  it("reads the model from a current Copilot log, which has no assistant.usage", () => {
    process.env["COPILOT_HOME"] = join(home, "copilot")
    seedSession("cs1b")
    writeLog("cs1b", [
      JSON.stringify({
        id: "b1",
        timestamp: new Date().toISOString(),
        type: "session.start",
        data: { sessionId: "cs1b", selectedModel: "claude-opus-5", reasoningEffort: "medium" },
      }),
      JSON.stringify({
        id: "b2",
        timestamp: new Date().toISOString(),
        type: "session.model_change",
        data: { previousModel: "claude-opus-5", newModel: "gpt-5.6-terra" },
      }),
    ])

    const tailer = new CopilotTailer(store, pipeline, 10_000)
    expect(tailer.tick()).toBe(2)

    const agent = store.listAgents("copilot:cs1b")[0]!
    expect(agent.model).toBe("gpt-5.6-terra")
    expect(agent.modelConfidence).toBe("reconciled")
  })

  it("skips subagent entries whose agent was never introduced", () => {
    process.env["COPILOT_HOME"] = join(home, "copilot")
    seedSession("cs2")
    writeLog("cs2", [
      JSON.stringify({ id: "e1", type: "assistant.message", agentId: "sub", data: { content: "sub text" } }),
      JSON.stringify({ id: "e2", type: "assistant.message_delta", ephemeral: true, data: { deltaContent: "x" } }),
    ])

    const tailer = new CopilotTailer(store, pipeline, 10_000)
    expect(tailer.tick()).toBe(0)
  })

  it("recovers the user's own turns, which no hook states exactly once", () => {
    process.env["COPILOT_HOME"] = join(home, "copilot")
    seedSession("cs4")
    writeLog("cs4", [
      JSON.stringify({
        id: "u1",
        timestamp: new Date().toISOString(),
        type: "user.message",
        // The transformed form is what the model saw; the transcript shows what
        // the human typed.
        data: { content: "look at this", transformedContent: "look at this\n<system_reminder>noise</system_reminder>" },
      }),
    ])

    const tailer = new CopilotTailer(store, pipeline, 10_000)
    expect(tailer.tick()).toBe(1)

    const agent = store.listAgents("copilot:cs4")[0]!
    const message = store.listMessages(agent.id)[0]!
    expect(message.role).toBe("user")
    expect(message.text).toBe("look at this")
  })

  it("keeps the files a turn carried, addressable by id", () => {
    process.env["COPILOT_HOME"] = join(home, "copilot")
    seedSession("cs5")
    writeLog("cs5", [
      JSON.stringify({
        id: "u1",
        timestamp: new Date().toISOString(),
        type: "user.message",
        data: {
          content: "why does this look wrong?",
          attachments: [
            { displayName: "Pasted Image", path: "/tmp/shot.png", type: "file", mimeType: "image/png", byteLength: 12 },
            { displayName: "no path", type: "file" },
          ],
        },
      }),
    ])

    const tailer = new CopilotTailer(store, pipeline, 10_000)
    tailer.tick()

    const agent = store.listAgents("copilot:cs5")[0]!
    const attachments = store.listMessages(agent.id)[0]?.attachments ?? []
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ name: "Pasted Image", path: "/tmp/shot.png", mimeType: "image/png" })
    expect(store.getAttachment(attachments[0]!.id)?.path).toBe("/tmp/shot.png")
  })

  it("routes a subagent's transcript to the node the hooks named", () => {
    process.env["COPILOT_HOME"] = join(home, "copilot")
    seedSession("cs6")
    pipeline.ingestHook({
      host: "copilot",
      event: "subagentStart",
      deliveryId: "sub:cs6",
      workspaceRoot: "/repo",
      payload: { sessionId: "cs6", agentName: "code-review", agentDisplayName: "Code Review Agent" },
    })
    writeLog("cs6", [
      JSON.stringify({
        id: "s1",
        timestamp: new Date().toISOString(),
        type: "subagent.started",
        agentId: "call_1",
        data: { agentName: "code-review", toolCallId: "call_1" },
      }),
      JSON.stringify({
        id: "s2",
        timestamp: new Date().toISOString(),
        type: "user.message",
        agentId: "call_1",
        data: {
          content: "review this screenshot",
          attachments: [{ displayName: "shot", path: "/tmp/review.png", mimeType: "image/png" }],
        },
      }),
      JSON.stringify({
        id: "s3",
        timestamp: new Date().toISOString(),
        type: "assistant.message",
        agentId: "call_1",
        data: { messageId: "m1", content: "looks good" },
      }),
    ])

    const tailer = new CopilotTailer(store, pipeline, 10_000)
    tailer.tick()

    const sub = store.listAgents("copilot:cs6").find((agent) => agent.agentKey === "sub:code-review")!
    const messages = store.listMessages(sub.id)
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(messages[0]?.attachments?.[0]?.name).toBe("shot")
  })

  it("only reads newly appended lines on the next pass", () => {
    process.env["COPILOT_HOME"] = join(home, "copilot")
    seedSession("cs3")
    const first = JSON.stringify({ id: "e1", type: "assistant.message", data: { messageId: "m1", content: "one" } })
    writeLog("cs3", [first])

    const tailer = new CopilotTailer(store, pipeline, 10_000)
    expect(tailer.tick()).toBe(1)
    expect(tailer.tick()).toBe(0)

    writeLog("cs3", [
      first,
      JSON.stringify({ id: "e2", type: "assistant.message", data: { messageId: "m2", content: "two" } }),
    ])
    expect(tailer.tick()).toBe(1)
  })
})

describe("harness session title tailer", () => {
  function seed(host: "codex" | "copilot" | "claude", sessionKey: string, cwd = "/repo"): void {
    pipeline.ingestHook({
      host,
      event: host === "copilot" ? "sessionStart" : "SessionStart",
      deliveryId: `title-seed:${host}:${sessionKey}`,
      workspaceRoot: cwd,
      payload: host === "copilot" ? { sessionId: sessionKey, cwd } : { session_id: sessionKey, cwd },
    })
  }

  it("inherits Codex thread names and follows later renames", () => {
    const codexHome = join(home, "codex")
    process.env["CODEX_HOME"] = codexHome
    mkdirSync(codexHome, { recursive: true })
    seed("codex", "cx1")
    const index = join(codexHome, "session_index.jsonl")
    writeFileSync(index, `${JSON.stringify({ id: "cx1", thread_name: "Inspect the ingest path" })}\n`)

    const tailer = new SessionTitleTailer(store, pipeline, 10_000)
    expect(tailer.tick()).toBe(1)
    expect(store.getSession("codex:cx1")?.title).toBe("Inspect the ingest path")

    writeFileSync(index, `${JSON.stringify({ id: "cx1", thread_name: "Repair the ingest path" })}\n`)
    expect(tailer.tick()).toBe(1)
    expect(store.getSession("codex:cx1")?.title).toBe("Repair the ingest path")
  })

  it("inherits the Copilot workspace name", () => {
    const copilotHome = join(home, "copilot-titles")
    process.env["COPILOT_HOME"] = copilotHome
    seed("copilot", "cp1")
    const directory = join(copilotHome, "session-state", "cp1")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "workspace.yaml"), "id: cp1\nname: Review release readiness\nuser_named: false\n")

    const tailer = new SessionTitleTailer(store, pipeline, 10_000)
    expect(tailer.tick()).toBe(1)
    expect(store.getSession("copilot:cp1")?.title).toBe("Review release readiness")
  })

  it("uses Claude's renamed title ahead of its generated title and first prompt", () => {
    const claudeHome = join(home, "claude")
    process.env["CLAUDE_CONFIG_DIR"] = claudeHome
    seed("claude", "cl1")
    const directory = join(claudeHome, "projects", encodeClaudeProjectPath("/repo"))
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, "cl1.jsonl"),
      [
        JSON.stringify({ type: "user", message: { content: "Investigate the session sidebar" } }),
        JSON.stringify({ type: "ai-title", aiTitle: "Investigate sidebar titles" }),
        JSON.stringify({ type: "custom-title", customTitle: "Ship inherited session titles" }),
      ].join("\n") + "\n",
    )

    const tailer = new SessionTitleTailer(store, pipeline, 10_000)
    expect(tailer.tick()).toBe(1)
    expect(store.getSession("claude:cl1")?.title).toBe("Ship inherited session titles")
  })
})

describe("Codex subagent transcript recovery", () => {
  it("puts the root agent's complete user and assistant history in its Chat transcript", () => {
    const transcript = join(home, "root.jsonl")
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          timestamp: "2026-08-25T09:00:00.000Z",
          type: "response_item",
          payload: {
            id: "root-user-1",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Inspect the current branch." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-25T09:00:01.000Z",
          type: "response_item",
          payload: {
            id: "root-assistant-1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I found two affected modules." }],
          },
        }),
      ].join("\n") + "\n",
    )

    pipeline.ingestHook({
      host: "codex",
      event: "SessionStart",
      deliveryId: "codex-root-history",
      workspaceRoot: "/repo",
      payload: { session_id: "root-history", model: "gpt-5.6-sol", transcript_path: transcript },
    })

    const root = store.listAgents("codex:root-history").find((agent) => agent.agentKey === "main")!
    expect(store.listMessages(root.id).map((message) => [message.role, message.text])).toEqual([
      ["user", "Inspect the current branch."],
      ["assistant", "I found two affected modules."],
    ])
  })

  it("puts the subagent's user and assistant messages in its Chat transcript", () => {
    pipeline.ingestHook({
      host: "codex",
      event: "SessionStart",
      deliveryId: "codex-start",
      workspaceRoot: "/repo",
      payload: { session_id: "root", model: "gpt-5.6-sol" },
    })
    const transcript = join(home, "child.jsonl")
    const inheritedPlugins = JSON.stringify({
      timestamp: "2026-08-25T09:59:58.000Z",
      type: "response_item",
      payload: {
        id: "inherited-plugins",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<recommended_plugins>uninstalled plugin noise</recommended_plugins>" }],
      },
    })
    const inheritedRootReply = JSON.stringify({
      timestamp: "2026-08-25T09:59:59.000Z",
      type: "response_item",
      payload: {
        id: "inherited-root-reply",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I will delegate the adapter review." }],
      },
    })
    const userMessage = JSON.stringify({
      timestamp: "2026-08-25T10:00:00.000Z",
      type: "response_item",
      payload: {
        id: "user-1",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Review the adapter." }],
      },
    })
    const assistantMessage = JSON.stringify({
      timestamp: "2026-08-25T10:00:01.000Z",
      type: "response_item",
      payload: {
        id: "assistant-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The adapter drops the transcript." }],
      },
    })
    writeFileSync(transcript, `${inheritedPlugins}\n${inheritedRootReply}\n${userMessage}\n`)

    pipeline.ingestHook({
      host: "codex",
      event: "PreToolUse",
      deliveryId: "codex-spawn-child",
      workspaceRoot: "/repo",
      payload: {
        session_id: "root",
        tool_name: "spawn_agent",
        tool_use_id: "spawn-child",
        tool_input: { task_name: "adapter-review", message: "Review the adapter." },
      },
    })

    pipeline.ingestHook({
      host: "codex",
      event: "SubagentStart",
      deliveryId: "codex-sub-start",
      workspaceRoot: "/repo",
      payload: {
        session_id: "root",
        agent_id: "child",
        agent_type: "reviewer",
        agent_transcript_path: transcript,
      },
    })

    const runningSubagent = store.listAgents("codex:root").find((agent) => agent.agentKey === "agent:child")!
    expect(store.listMessages(runningSubagent.id).map((message) => message.text)).toEqual(["Review the adapter."])

    writeFileSync(transcript, `${inheritedPlugins}\n${inheritedRootReply}\n${userMessage}\n${assistantMessage}\n`)
    const toolResult = pipeline.ingestHook({
      host: "codex",
      event: "PreToolUse",
      deliveryId: "codex-sub-tool",
      workspaceRoot: "/repo",
      payload: {
        session_id: "root",
        agent_id: "child",
        transcript_path: transcript,
        tool_name: "read_file",
        tool_use_id: "tool-1",
      },
    })
    expect(store.listMessages(runningSubagent.id).map((message) => message.text)).toEqual([
      "Review the adapter.",
      "The adapter drops the transcript.",
    ])
    expect(toolResult.duplicates).toBe(1)

    const stopResult = pipeline.ingestHook({
      host: "codex",
      event: "SubagentStop",
      deliveryId: "codex-sub-stop",
      workspaceRoot: "/repo",
      payload: {
        session_id: "root",
        agent_id: "child",
        agent_type: "reviewer",
        agent_transcript_path: transcript,
        last_assistant_message: "The adapter drops the transcript.",
      },
    })

    const subagent = store.listAgents("codex:root").find((agent) => agent.agentKey === "agent:child")!
    expect(store.listMessages(subagent.id).map((message) => [message.role, message.text])).toEqual([
      ["user", "Review the adapter."],
      ["assistant", "The adapter drops the transcript."],
    ])
    expect(stopResult.duplicates).toBe(2)
  })
})

describe("Broadcaster integration", () => {
  it("publishes reducer output to connected clients", () => {
    const broadcaster = new Broadcaster()
    const received: string[] = []
    broadcaster.add({ send: (data) => received.push(data), close: () => undefined })

    const local = new Pipeline({ store, config, onChanges: (changes) => broadcaster.publish(changes) })
    local.ingestHook({
      host: "codex",
      event: "SessionStart",
      deliveryId: "d",
      workspaceRoot: "/repo",
      payload: { session_id: "s1", model: "gpt-5.3-codex" },
    })

    expect(received).toHaveLength(1)
    expect(JSON.parse(received[0]!).type).toBe("changes")
  })
})

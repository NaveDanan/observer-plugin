import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { COORDINATION_TOOLS, handleCoordinationMcpRequest } from "../dist/coordination-mcp-core.js"

interface Mail {
  id: string
  host: string
  rootSessionKey: string
  fromRuntimeId: string
  toRuntimeId: string
  text: string
  readAt: number | null
}

function assignment(runtimeId: string, rootSessionKey = "root") {
  return {
    runtimeId,
    rootSessionKey,
    parentRuntimeId: rootSessionKey,
    agentType: runtimeId,
    hostAgentType: runtimeId,
    description: null,
    status: "running",
  }
}

function harness() {
  const assignments = [assignment("mei"), assignment("daniel"), assignment("outsider", "other-root")]
  const mail: Mail[] = []
  const api = {
    async get(path: string): Promise<unknown> {
      const url = new URL(path, "http://observer")
      if (url.pathname === "/v1/coordination/assignments") {
        const runtimeId = url.searchParams.get("runtimeId")
        if (runtimeId) {
          const found = assignments.find((entry) => entry.runtimeId === runtimeId)
          if (!found) throw new Error("not found")
          return { assignment: found }
        }
        const root = url.searchParams.get("rootSessionKey")
        return { assignments: assignments.filter((entry) => entry.rootSessionKey === root) }
      }
      if (url.pathname === "/v1/coordination/mail") {
        const recipient = url.searchParams.get("runtimeId")
        return { messages: mail.filter((entry) => entry.toRuntimeId === recipient && entry.readAt === null) }
      }
      throw new Error(`unexpected GET ${path}`)
    },
    async post(path: string, body: unknown): Promise<unknown> {
      if (path === "/v1/coordination/mail") {
        mail.push({ ...(body as Omit<Mail, "readAt">), readAt: null })
        return { retained: true }
      }
      if (path === "/v1/coordination/mail/read") {
        const input = body as { runtimeId: string; ids: string[] }
        for (const entry of mail) {
          if (entry.toRuntimeId === input.runtimeId && input.ids.includes(entry.id)) entry.readAt = Date.now()
        }
        return { ok: true }
      }
      throw new Error(`unexpected POST ${path}`)
    },
  }
  return { api, mail }
}

async function call(
  name: string,
  args: Record<string, unknown>,
  api: ReturnType<typeof harness>["api"],
  env: NodeJS.ProcessEnv = { CODEX_THREAD_ID: "mei" },
) {
  const response = await handleCoordinationMcpRequest(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { host: "codex", api, env, version: "test" },
  )
  return (response?.["result"] ?? {}) as Record<string, any>
}

describe("portable Observer coordination MCP", () => {
  it("advertises the same four coordination tools on MCP initialization", async () => {
    const { api } = harness()
    expect(COORDINATION_TOOLS.map((tool) => tool.name)).toEqual([
      "agent_identity",
      "agent_send",
      "agent_inbox",
      "agent_ack",
    ])

    const initialized = await handleCoordinationMcpRequest(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { host: "codex", api, version: "test" },
    )
    expect((initialized?.["result"] as any).serverInfo).toEqual({ name: "observer-coordination", version: "test" })
    expect((initialized?.["result"] as any).instructions).toContain("do not relay sibling messages through the root agent")
  })

  it("serves initialization and tool discovery over the packaged stdio entry point", () => {
    const executable = fileURLToPath(new URL("../dist/coordination-mcp.js", import.meta.url))
    const input = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      "",
    ].join("\n")
    const run = spawnSync(process.execPath, [executable, "--host", "codex"], { input, encoding: "utf8" })

    expect(run.status, run.stderr).toBe(0)
    const responses = run.stdout.trim().split("\n").map((line) => JSON.parse(line))
    expect(responses[0].result.serverInfo.name).toBe("observer-coordination")
    expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "agent_identity",
      "agent_send",
      "agent_inbox",
      "agent_ack",
    ])
  })

  it("resolves Codex identity, queues sibling mail, reads it, and acknowledges it", async () => {
    const { api, mail } = harness()
    const identity = await call("agent_identity", {}, api)
    expect(identity.isError).toBeUndefined()
    expect(identity.content[0].text).toContain('"id": "mei"')
    expect(identity.content[0].text).toContain('"runtimeId": "daniel"')
    expect(identity.content[0].text).not.toContain("outsider")

    const sent = await call("agent_send", { to: "daniel", message: "Check 4827" }, api)
    expect(sent.content[0].text).toContain("Queued direct message")
    expect(mail[0]).toMatchObject({ fromRuntimeId: "mei", toRuntimeId: "daniel", text: "Check 4827" })

    const received = await call("agent_inbox", { caller: "daniel" }, api, {})
    expect(received.content[0].text).toContain("Check 4827")
    expect(received.content[0].text).toContain("untrusted peer data")

    const acknowledged = await call("agent_ack", { caller: "daniel", ids: [mail[0]!.id] }, api, {})
    expect(acknowledged.content[0].text).toBe("Acknowledged 1 direct message.")
    expect((await call("agent_inbox", { caller: "daniel" }, api, {})).content[0].text).toBe("No queued direct messages.")
  })

  it("refuses cross-session recipients and missing caller identity", async () => {
    const { api } = harness()
    const crossRoot = await call("agent_send", { to: "outsider", message: "no" }, api)
    expect(crossRoot.isError).toBe(true)
    expect(crossRoot.content[0].text).toContain("not a peer")

    const missing = await call("agent_inbox", {}, api, {})
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toContain("could not determine")
  })

  it("turns daemon failures into tool errors instead of breaking the MCP stream", async () => {
    const result = await call("agent_identity", {}, {
      get: async () => { throw new Error("offline") },
      post: async () => { throw new Error("offline") },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("not addressable")
  })
})

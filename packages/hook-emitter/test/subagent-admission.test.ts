import { afterEach, describe, expect, it, vi } from "vitest"
import { admitSubagent, readLimits } from "../dist/subagent-admission.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("shared subagent admission", () => {
  it("does not contact the daemon for an unrelated tool", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)

    await expect(
      admitSubagent("codex", { session_id: "session", tool_name: "apply_patch", tool_input: {} }, { port: 4599, token: "token" }),
    ).resolves.toEqual({ controlled: false, allowed: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("reserves a durable slot before Claude creates a subagent", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ assignment: { id: "reserved" } }))
    vi.stubGlobal("fetch", fetch)

    await expect(
      admitSubagent(
        "claude",
        {
          session_id: "root-session",
          agent_id: "parent-agent",
          tool_name: "Agent",
          tool_use_id: "call-1",
          tool_input: { subagent_type: "worker", description: "Audit auth", prompt: "Review the flow" },
        },
        { port: 4611, token: "secret", subagentLimits: { maxDepth: 4, maxPerSession: 30 } },
      ),
    ).resolves.toEqual({ controlled: true, allowed: true })

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe("http://127.0.0.1:4611/v1/coordination/assignments")
    expect(init.headers.authorization).toBe("Bearer secret")
    expect(JSON.parse(init.body)).toMatchObject({
      host: "claude",
      rootSessionKey: "root-session",
      parentRuntimeId: "parent-agent",
      callId: "call-1",
      agentType: "worker",
      status: "starting",
    })
  })

  it("passes the daemon's hard-cap denial back to the host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ error: "subagent limit reached (6 per session)" }, { status: 409 })),
    )

    await expect(
      admitSubagent(
        "copilot",
        { sessionId: "session", toolName: "task", toolArgs: { agent_type: "general" } },
        { port: 4599, token: "token" },
      ),
    ).resolves.toEqual({
      controlled: true,
      allowed: false,
      reason: "Subagent limit reached (6 per session).",
    })
  })

  it("gives identical Copilot calls separate reservations when the host supplies no call id", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ assignment: { id: "reserved" } }))
    vi.stubGlobal("fetch", fetch)
    const payload = { sessionId: "session", toolName: "task", toolArgs: { agent_type: "general" } }
    const config = { port: 4599, token: "token" }

    await admitSubagent("copilot", payload, config)
    await admitSubagent("copilot", payload, config)

    const first = JSON.parse(fetch.mock.calls[0]![1].body)
    const second = JSON.parse(fetch.mock.calls[1]![1].body)
    expect(first.callId).not.toBe(second.callId)
    expect(first.id).not.toBe(second.id)
  })

  it("blocks creation when the durable admission check is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))

    const decision = await admitSubagent(
      "codex",
      { session_id: "session", tool_name: "spawn_agent", tool_input: { agent_type: "worker" } },
      { port: 4599, token: "token", subagentLimits: { maxDepth: 5, maxPerSession: 22 } },
    )
    expect(decision).toMatchObject({ controlled: true, allowed: false })
    expect(decision.reason).toContain("5 levels, 22 per session")
  })

  it("bounds malformed local display values without changing the daemon policy", () => {
    expect(readLimits({ maxDepth: 100, maxPerSession: -1 })).toEqual({ maxDepth: 2, maxPerSession: 15 })
    expect(readLimits({ maxDepth: 0, maxPerSession: 0 })).toEqual({ maxDepth: 0, maxPerSession: 0 })
  })
})

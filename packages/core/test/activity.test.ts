import { describe, expect, it } from "vitest"
import { currentActivity, formatElapsed } from "@observer-ai/core"
import type { ToolCallEntity } from "@observer-ai/protocol"

function tool(overrides: Partial<ToolCallEntity> = {}): ToolCallEntity {
  return {
    id: "claude:s1~main~t:1",
    sessionId: "claude:s1",
    agentId: "claude:s1~main",
    callId: "1",
    tool: "Bash",
    title: null,
    input: null,
    output: null,
    error: null,
    status: "running",
    startedAt: 1_000,
    endedAt: null,
    durationMs: null,
    ...overrides,
  }
}

describe("currentActivity", () => {
  it("returns the running tool and elapsed time", () => {
    const result = currentActivity([tool({ startedAt: 1_000 })], 4_000)
    expect(result?.tool.tool).toBe("Bash")
    expect(result?.elapsedMs).toBe(3_000)
  })

  it("returns undefined for an idle agent", () => {
    expect(currentActivity([], 2_000)).toBeUndefined()
    expect(currentActivity([tool({ status: "ok" })], 2_000)).toBeUndefined()
  })

  it("picks the most recent running call when several exist", () => {
    const calls = [
      tool({ callId: "1", tool: "Read", startedAt: 1_000, status: "running" }),
      tool({ id: "claude:s1~main~t:2", callId: "2", tool: "Grep", startedAt: 2_000, status: "running" }),
      tool({ id: "claude:s1~main~t:3", callId: "3", tool: "Bash", startedAt: 500, status: "ok" }),
    ]
    const result = currentActivity(calls, 3_000)
    expect(result?.tool.tool).toBe("Grep")
  })
})

describe("formatElapsed", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(5_000)).toBe("5s")
    expect(formatElapsed(65_000)).toBe("1m 5s")
    expect(formatElapsed(3_700_000)).toBe("1h 1m")
  })
})

import { describe, expect, it } from "vitest"
import type { SessionEntity } from "@observer-ai/protocol"
import { sessionTitle } from "../src/SessionSidebar"

function session(title: string | null, goal = "Observer's derived goal"): SessionEntity {
  return {
    id: "codex:s1",
    host: "codex",
    hostVersion: null,
    sessionKey: "s1",
    workspaceRoot: "/repo",
    title,
    status: "active",
    model: null,
    goal,
    goalStatus: "derived",
    cwd: "/repo",
    startedAt: 1,
    endedAt: null,
    updatedAt: 1,
    lastEventSeq: 1,
  }
}

describe("sessionTitle", () => {
  it("uses the title reported by the harness", () => {
    expect(sessionTitle(session("Harness-owned title"))).toBe("Harness-owned title")
  })

  it("does not substitute Observer's goal or the raw session id", () => {
    expect(sessionTitle(session(null))).toBe("Title pending from harness")
    expect(sessionTitle(session("   "))).toBe("Title pending from harness")
  })
})

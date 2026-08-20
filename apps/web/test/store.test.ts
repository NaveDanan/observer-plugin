import { describe, expect, it } from "vitest"
import type { SessionEntity } from "@observer-ai/protocol"
import { selectSessions } from "../src/store"

function session(host: SessionEntity["host"], key: string, updatedAt: number): SessionEntity {
  return {
    id: `${host}:${key}`,
    host,
    hostVersion: null,
    sessionKey: key,
    workspaceRoot: "/repo",
    title: null,
    status: "active",
    model: null,
    goal: null,
    goalStatus: null,
    cwd: null,
    startedAt: updatedAt,
    endedAt: null,
    updatedAt,
    lastEventSeq: 0,
  }
}

function stateWith(scopeHost: string | undefined, sessions: SessionEntity[]) {
  return {
    scopeHost,
    sessions: new Map(sessions.map((entry) => [entry.id, entry])),
  } as unknown as Parameters<typeof selectSessions>[0]
}

const all = [session("claude", "cl-1", 30), session("codex", "cx-1", 20), session("opencode", "oc-1", 10)]

describe("session scope", () => {
  it("shows only the harness the canvas is bound to", () => {
    // Observer is opened by a harness and stays connected to it; there is no
    // in-app picker, so this filter is the whole binding.
    expect(selectSessions(stateWith("codex", all)).map((s) => s.id)).toEqual(["codex:cx-1"])
    expect(selectSessions(stateWith("claude", all)).map((s) => s.id)).toEqual(["claude:cl-1"])
  })

  it("shows every harness when unbound", () => {
    expect(selectSessions(stateWith(undefined, all))).toHaveLength(3)
  })

  it("returns nothing when the bound harness has no sessions yet", () => {
    expect(selectSessions(stateWith("copilot", all))).toEqual([])
  })

  it("orders by most recent activity", () => {
    const ordered = selectSessions(stateWith(undefined, all)).map((s) => s.id)
    expect(ordered).toEqual(["claude:cl-1", "codex:cx-1", "opencode:oc-1"])
  })
})

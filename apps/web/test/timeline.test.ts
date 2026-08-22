import { describe, expect, it } from "vitest"
import type { MessageEntity, ToolCallEntity } from "@observer-ai/protocol"
import { buildTimeline, summarise, toolAction } from "../src/chat/timeline"

function message(id: string, role: MessageEntity["role"], seq: number, createdAt: number, updatedAt = createdAt): MessageEntity {
  return {
    id,
    sessionId: "s1",
    agentId: "a1",
    role,
    messageKey: id,
    text: id,
    streaming: false,
    createdAt,
    updatedAt,
    seq,
  }
}

function call(id: string, tool: string, startedAt: number, extra: Partial<ToolCallEntity> = {}): ToolCallEntity {
  return {
    id,
    sessionId: "s1",
    agentId: "a1",
    callId: id,
    tool,
    title: null,
    input: null,
    output: null,
    error: null,
    status: "ok",
    startedAt,
    endedAt: startedAt + 10,
    durationMs: 10,
    ...extra,
  } as ToolCallEntity
}

describe("buildTimeline", () => {
  it("interleaves tool calls between the messages they happened between", () => {
    const rows = buildTimeline(
      [message("m1", "assistant", 1, 1000), message("m2", "assistant", 2, 3000)],
      [call("t1", "read", 1500), call("t2", "read", 1600)],
    )
    expect(rows.map((row) => row.kind)).toEqual(["message", "tools", "message"])
    // The two adjacent reads collapse into one run rather than two rows.
    expect(rows[1]).toMatchObject({ kind: "tools", action: "read" })
    expect(rows[1]!.kind === "tools" && rows[1]!.calls.map((c) => c.id)).toEqual(["t1", "t2"])
  })

  it("keeps message order by seq even when timestamps disagree with it", () => {
    // Two messages stamped out of order relative to their sequence. Sorting the
    // union by time would swap them, which is a lie about what was said first.
    const rows = buildTimeline([message("m1", "assistant", 1, 5000), message("m2", "assistant", 2, 4000)], [])
    expect(rows.map((row) => row.id)).toEqual(["m1", "m2"])
  })

  it("places a tool call by when it started, not when it finished", () => {
    // A slow command must stay next to the sentence that explains it.
    const rows = buildTimeline(
      [message("m1", "assistant", 1, 1000), message("m2", "assistant", 2, 2000)],
      [call("slow", "bash", 1500, { endedAt: 90_000, durationMs: 88_500 })],
    )
    expect(rows.map((row) => row.id)).toEqual(["m1", "tools:slow", "m2"])
  })

  it("gives a tie to the message, so the announcement precedes the call", () => {
    const rows = buildTimeline([message("m1", "assistant", 1, 1000)], [call("t1", "read", 1000)])
    expect(rows.map((row) => row.id)).toEqual(["m1", "tools:t1"])
  })

  it("breaks message grouping across an intervening tool run", () => {
    const rows = buildTimeline(
      [message("m1", "assistant", 1, 1000), message("m2", "assistant", 2, 2000)],
      [call("t1", "read", 1500)],
    )
    // Same role, well inside the grouping window — but a tool run sits between
    // them, so the second must reintroduce itself rather than read as a
    // continuation of the first.
    expect(rows[2]).toMatchObject({ kind: "message", grouped: false })
  })

  it("still groups consecutive same-role messages with nothing between", () => {
    const rows = buildTimeline([message("m1", "assistant", 1, 1000), message("m2", "assistant", 2, 2000)], [])
    expect(rows[1]).toMatchObject({ grouped: true })
  })

  it("does not group across a change of speaker", () => {
    const rows = buildTimeline([message("m1", "user", 1, 1000), message("m2", "assistant", 2, 2000)], [])
    expect(rows[1]).toMatchObject({ grouped: false })
  })

  it("does not group messages separated by more than the window", () => {
    const rows = buildTimeline([message("m1", "assistant", 1, 0), message("m2", "assistant", 2, 200_000)], [])
    expect(rows[1]).toMatchObject({ grouped: false })
  })

  it("handles a transcript that is only tool calls", () => {
    const rows = buildTimeline([], [call("t1", "bash", 1), call("t2", "bash", 2)])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "tools", action: "command" })
  })

  it("handles empty input", () => {
    expect(buildTimeline([], [])).toEqual([])
  })

  it("flags a run containing a failure and one still running", () => {
    const rows = buildTimeline(
      [],
      [call("t1", "bash", 1, { status: "error" }), call("t2", "bash", 2, { status: "running" })],
    )
    expect(rows[0]).toMatchObject({ failed: true, running: true })
  })

  it("falls back to a mixed run when tools disagree about what they did", () => {
    const rows = buildTimeline([], [call("t1", "read", 1), call("t2", "bash", 2)])
    expect(rows[0]).toMatchObject({ action: "other", summary: "Used 2 tools" })
  })
})

describe("toolAction", () => {
  it.each([
    ["read", "read"],
    ["Read", "read"],
    ["read_file", "read"],
    ["view", "read"],
    ["edit", "edit"],
    ["str_replace_editor", "edit"],
    ["write", "edit"],
    ["bash", "command"],
    ["shell_exec", "command"],
    ["grep", "search"],
    ["glob", "search"],
    ["task", "task"],
    ["todowrite", "todo"],
    ["something_unknown", "other"],
  ])("maps %s to %s", (tool, expected) => {
    expect(toolAction(tool)).toBe(expected)
  })

  it("prefers the more specific reading for names that match twice", () => {
    // `todowrite` contains "write", which would otherwise make it an edit.
    expect(toolAction("todowrite")).toBe("todo")
  })
})

describe("summarise", () => {
  it("names the tool outright when there is only one call", () => {
    expect(summarise([call("t1", "bash", 1)])).toBe("bash")
  })

  it("prefers a host-supplied title over the raw tool name", () => {
    expect(summarise([call("t1", "bash", 1, { title: "pnpm test" })])).toBe("pnpm test")
  })

  it("counts distinct paths, not calls, for reads and edits", () => {
    // Reading the same file twice is one file touched twice. Counting it as
    // two overstates how much of the tree the turn actually looked at.
    const calls = [
      call("t1", "read", 1, { input: { filePath: "a.ts" } }),
      call("t2", "read", 2, { input: { filePath: "a.ts" } }),
      call("t3", "read", 3, { input: { filePath: "b.ts" } }),
    ]
    expect(summarise(calls)).toBe("Read 2 files")
  })

  it("counts calls, not subjects, for commands", () => {
    expect(summarise([call("t1", "bash", 1), call("t2", "bash", 2)])).toBe("Ran 2 commands")
  })

  it("returns an empty string for an empty run rather than throwing", () => {
    expect(summarise([])).toBe("")
  })
})

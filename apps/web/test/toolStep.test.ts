import { describe, expect, it } from "vitest"
import type { ToolCallEntity } from "@observer-ai/protocol"
import { describeToolCall, formatBytes, formatCount, languageForPath, stripGutter } from "../src/chat/toolStep"

/**
 * These cases are written twice on purpose — once in OpenCode's argument
 * vocabulary and once in Copilot's — because that difference is exactly what
 * used to make one host's transcript read as "used a tool" while the other
 * read as a sentence.
 */
function call(tool: string, extra: Partial<ToolCallEntity> = {}): ToolCallEntity {
  return {
    id: "c1",
    sessionId: "s1",
    agentId: "a1",
    callId: "c1",
    tool,
    title: null,
    input: null,
    output: null,
    error: null,
    status: "ok",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_000_900,
    durationMs: 900,
    ...extra,
  } as ToolCallEntity
}

describe("describeToolCall — commands", () => {
  it("titles a shell call with the command itself, behind the tool's name", () => {
    const step = describeToolCall(call("bash", { input: { command: "pnpm test", description: "Run the suite" } }))
    expect(step.title).toBe("pnpm test")
    expect(step.lead).toBe("Bash")
    expect(step.subject).toEqual({ kind: "command", value: "pnpm test" })
    // The command is the card's own header; repeating it as a field would say
    // the same thing twice in two lines.
    expect(step.fields).toEqual([{ label: "Purpose", value: "Run the suite", mono: false }])
  })

  it("reads a Copilot tool name as words", () => {
    const step = describeToolCall(call("run_in_terminal", { input: { command: "ls" } }))
    expect(step.lead).toBe("Run in terminal")
  })

  it("drops the lead when the host wrote its own sentence", () => {
    const step = describeToolCall(call("bash", { title: "Ran the suite", input: { command: "pnpm test" } }))
    expect(step.lead).toBeNull()
    expect(step.title).toBe("Ran the suite")
  })

  it("shows output as a terminal, not a file", () => {
    const step = describeToolCall(call("bash", { input: { command: "ls" }, output: "a\nb\n" }))
    expect(step.output).toEqual({ kind: "terminal", text: "a\nb\n" })
  })

  it("reports an exit code when the output carries one", () => {
    const step = describeToolCall(call("bash", { input: { command: "false" }, output: "boom\n<shellId: 3 completed with exit code 1>" }))
    expect(step.meta).toBe("exit 1")
  })

  it("falls back to the duration when no exit code was reported", () => {
    expect(describeToolCall(call("bash", { input: { command: "ls" }, output: "a" })).meta).toBe("900ms")
  })
})

describe("describeToolCall — searches", () => {
  it("names the pattern for an OpenCode grep", () => {
    const step = describeToolCall(call("grep", { input: { pattern: "buildTimeline", include: "*.ts" }, output: "a.ts:1\nb.ts:4" }))
    expect(step.title).toBe("Searched buildTimeline")
    expect(step.meta).toBe("2 matches")
    expect(step.output).toEqual({ kind: "list", items: ["a.ts:1", "b.ts:4"] })
  })

  it("names the pattern for a Copilot glob, and counts files", () => {
    const step = describeToolCall(call("glob", { input: { pattern: "**/*.ts", paths: ["src", "test"] }, output: "a.ts\nb.ts\nc.ts" }))
    expect(step.title).toBe("Searched **/*.ts")
    expect(step.meta).toBe("3 files")
    expect(step.fields).toContainEqual({ label: "In", value: "src, test", mono: true })
  })

  it("says so when a search found nothing rather than showing an empty card", () => {
    const step = describeToolCall(call("grep", { input: { pattern: "nope" }, output: "" }))
    expect(step.meta).toBe("0 matches")
    expect(step.output).toEqual({ kind: "text", text: "No matches." })
  })
})

describe("describeToolCall — reads", () => {
  it("titles an OpenCode read by file name and counts the lines", () => {
    const step = describeToolCall(call("read", { input: { filePath: "/repo/apps/web/src/App.tsx" }, output: "one\ntwo\nthree" }))
    expect(step.title).toBe("Read App.tsx")
    expect(step.meta).toBe("3 lines")
    expect(step.subject).toEqual({ kind: "path", value: "/repo/apps/web/src/App.tsx" })
    expect(step.output).toMatchObject({ kind: "code", language: "tsx", firstLine: 1 })
  })

  it("carries a Copilot view range into the title and the gutter", () => {
    const step = describeToolCall(call("view", { input: { path: "README.md", view_range: [40, 42] }, output: "a\nb\nc" }))
    expect(step.title).toBe("Read README.md:40-42")
    expect(step.output).toMatchObject({ kind: "code", firstLine: 40, language: "markdown" })
  })

  it("understands offset and limit as the same range", () => {
    const step = describeToolCall(call("read", { input: { filePath: "a.ts", offset: 10, limit: 5 }, output: "x" }))
    expect(step.title).toBe("Read a.ts:10-14")
  })

  it("keeps a host-supplied title rather than second-guessing it", () => {
    const step = describeToolCall(call("read", { title: "Reading the config", input: { filePath: "a.ts" } }))
    expect(step.title).toBe("Reading the config")
  })
})

describe("describeToolCall — edits, delegations, todos", () => {
  it("shows a Copilot edit as a diff, and sizes it from the host's own count", () => {
    const step = describeToolCall(
      call("edit", { input: { path: "src/a.ts", old_str: "const a = 1", new_str: "const a = 2" }, linesAdded: 1, linesRemoved: 1 }),
    )
    expect(step.title).toBe("Edit a.ts")
    expect(step.churn).toEqual({ added: 1, removed: 1 })
    expect(step.meta).toBeNull()
    expect(step.input).toEqual({
      kind: "diff",
      language: "ts",
      rows: [
        { sign: "-", text: "const a = 1" },
        { sign: "+", text: "const a = 2" },
      ],
    })
  })

  it("keeps the unchanged lines around a hunk as context", () => {
    const step = describeToolCall(
      call("edit", {
        input: { path: "a.ts", old_str: "one\ntwo\nthree", new_str: "one\nTWO\nthree" },
      }),
    )
    expect(step.input).toEqual({
      kind: "diff",
      language: "ts",
      rows: [
        { sign: " ", text: "one" },
        { sign: "-", text: "two" },
        { sign: "+", text: "TWO" },
        { sign: " ", text: "three" },
      ],
    })
    expect(step.churn).toEqual({ added: 1, removed: 1 })
  })

  it("shows an OpenCode write as a creation, counted from the content", () => {
    const step = describeToolCall(call("write", { input: { filePath: "src/new.ts", content: "export {}\nexport {}" } }))
    expect(step.title).toBe("Create new.ts")
    expect(step.churn).toEqual({ added: 2, removed: 0 })
    expect(step.input).toEqual({
      kind: "diff",
      language: "ts",
      rows: [
        { sign: "+", text: "export {}" },
        { sign: "+", text: "export {}" },
      ],
    })
  })

  it("names the delegated agent and keeps the prompt as the body", () => {
    const step = describeToolCall(
      call("task", { input: { subagent_type: "explore", description: "Find the reducer", prompt: "Look in packages/core" } }),
    )
    expect(step.title).toBe("Find the reducer")
    expect(step.fields).toContainEqual({ label: "Agent", value: "explore", mono: true })
    expect(step.input).toEqual({ kind: "text", text: "Look in packages/core" })
  })

  it("renders a task list with its statuses", () => {
    const step = describeToolCall(
      call("todowrite", { input: { todos: [{ content: "Ship it", status: "in_progress" }, { content: "Test it", status: "pending" }] } }),
    )
    expect(step.meta).toBe("2 tasks")
    expect(step.input).toEqual({ kind: "list", items: ["◐ Ship it", "○ Test it"] })
  })
})

describe("describeToolCall — states", () => {
  it("says a running call is running rather than showing it as empty", () => {
    const step = describeToolCall(call("bash", { status: "running", durationMs: null, endedAt: null, input: { command: "sleep 5" } }))
    expect(step.meta).toBe("running")
    expect(step.running).toBe(true)
    expect(step.output).toBeNull()
  })

  it("leaves the output figures absent, not zero, when nothing came back", () => {
    const step = describeToolCall(call("bash", { input: { command: "true" } }))
    expect(step.stats.lines).toBeNull()
    expect(step.stats.bytes).toBeNull()
  })

  it("keeps the error text for a failed call", () => {
    const step = describeToolCall(call("bash", { status: "error", error: "command not found", input: { command: "nope" } }))
    expect(step.failed).toBe(true)
    expect(step.error).toBe("command not found")
  })

  it("falls back to the tool name and a printed payload for an unknown tool", () => {
    const step = describeToolCall(call("weather_lookup", { input: { city: "Cairo" } }))
    expect(step.title).toBe("weather_lookup")
    expect(step.input).toEqual({ kind: "text", text: '{\n  "city": "Cairo"\n}' })
  })
})

describe("stripGutter", () => {
  it("recovers the first line number from an OpenCode listing", () => {
    expect(stripGutter("00012| const a = 1\n00013| const b = 2\n00014| const c = 3")).toEqual({
      text: "const a = 1\nconst b = 2\nconst c = 3",
      firstLine: 12,
    })
  })

  it("recovers a dotted gutter too", () => {
    expect(stripGutter("1. alpha\n2. beta\n3. gamma")).toEqual({ text: "alpha\nbeta\ngamma", firstLine: 1 })
  })

  it("leaves content alone when the numbers do not ascend", () => {
    const text = "3 apples\n1 pear\n9 plums"
    expect(stripGutter(text)).toEqual({ text, firstLine: 1 })
  })

  it("leaves short content alone", () => {
    expect(stripGutter("1. only")).toEqual({ text: "1. only", firstLine: 1 })
  })
})

describe("formatting", () => {
  it("pluralises counts", () => {
    expect(formatCount(1, "line")).toBe("1 line")
    expect(formatCount(0, "match")).toBe("0 matches")
  })

  it("scales byte sizes", () => {
    expect(formatBytes(369)).toBe("369 B")
    expect(formatBytes(5734)).toBe("5.6 KB")
  })

  it("maps file names to grammars, and unknown ones to nothing", () => {
    expect(languageForPath("a/b/c.tsx")).toBe("tsx")
    expect(languageForPath("Dockerfile")).toBe("docker")
    expect(languageForPath("a/b/LICENSE")).toBeUndefined()
    expect(languageForPath(null)).toBeUndefined()
  })
})

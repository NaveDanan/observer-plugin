import { describe, expect, it } from "vitest"
import type { ToolCallEntity } from "@observer-ai/protocol"
import {
  countChurn,
  contentLines,
  describeToolCall,
  diffLines,
  formatBytes,
  formatCount,
  languageForPath,
  stripGutter,
} from "../src/chat/toolStep"

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

  it("keeps the exit code while clearly marking a failed command", () => {
    const step = describeToolCall(
      call("bash", {
        status: "error",
        input: { command: "false" },
        output: "boom\n<shellId: 3 completed with exit code 1>",
      }),
    )
    expect(step.meta).toBe("failed · exit 1")
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
    expect(step.stats).toMatchObject({ lines: null, bytes: null })
  })

  it("does not let captured error output make a failed search look successful", () => {
    const step = describeToolCall(call("grep", { status: "error", input: { pattern: "x" }, output: "permission denied" }))
    expect(step.meta).toBe("failed")
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

  it("renders the -1 view-range sentinel as an open-ended range", () => {
    const step = describeToolCall(call("view", { input: { path: "README.md", view_range: [40, -1] }, output: "a\nb" }))
    expect(step.title).toBe("Read README.md:40")
    expect(step.fields).toContainEqual({ label: "Lines", value: "from 40", mono: true })
  })

  it("understands offset and limit as the same range", () => {
    const step = describeToolCall(call("read", { input: { filePath: "a.ts", offset: 10, limit: 5 }, output: "x" }))
    expect(step.title).toBe("Read a.ts:10-14")
  })

  it("strips a short OpenCode gutter and preserves the final newline", () => {
    const step = describeToolCall(call("read", { input: { filePath: "a.ts", offset: 12, limit: 2 }, output: "00012| one\n00013| two\n" }))
    expect(step.output).toMatchObject({ kind: "code", text: "one\ntwo\n", firstLine: 12 })
    expect(step.meta).toBe("2 lines")
  })

  it("strips a dotted gutter only for a host tool known to add one", () => {
    const step = describeToolCall(call("view", { input: { path: "a.md" }, output: "40. first\n41. second" }))
    expect(step.output).toMatchObject({ kind: "code", text: "first\nsecond", firstLine: 40 })
  })

  it("preserves a Markdown ordered list returned by a generic read", () => {
    const text = "1. First\n2. Second\n3. Third"
    const step = describeToolCall(call("read", { input: { filePath: "list.md" }, output: text }))
    expect(step.output).toMatchObject({ kind: "code", text })
  })

  it("marks failed reads as failed instead of reporting captured error lines", () => {
    const step = describeToolCall(call("read", { status: "error", input: { filePath: "a.ts" }, output: "permission denied" }))
    expect(step.meta).toBe("failed")
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

  it("shows an OpenCode write neutrally because the input cannot prove creation", () => {
    const step = describeToolCall(call("write", { input: { filePath: "src/new.ts", content: "export {}\nexport {}" } }))
    expect(step.title).toBe("Write new.ts")
    expect(step.churn).toBeNull()
    expect(step.inputLabel).toBe("New content")
    expect(step.input).toEqual({
      kind: "code",
      text: "export {}\nexport {}",
      language: "ts",
      firstLine: 1,
    })
  })

  it("shows an explicitly named create tool as a creation diff", () => {
    const step = describeToolCall(call("create_file", { input: { path: "src/new.ts", content: "export {}" } }))
    expect(step.title).toBe("Create new.ts")
    expect(step.churn).toEqual({ added: 1, removed: 0 })
    expect(step.input).toMatchObject({
      kind: "diff",
      rows: [{ sign: "+", text: "export {}" }],
    })
  })

  it("does not classify non-file create tools as edits", () => {
    const step = describeToolCall(call("create_issue", { input: { title: "Bug", body: "Details" } }))
    expect(step.action).toBe("other")
    expect(step.churn).toBeNull()
    expect(step.input).toEqual({
      kind: "text",
      text: '{\n  "title": "Bug",\n  "body": "Details"\n}',
    })
  })

  it("does not derive a diff or churn from clipped create content", () => {
    const content = "export const value = 1\n… [truncated 40 characters]"
    const step = describeToolCall(call("create_file", { input: { path: "src/new.ts", content } }))
    expect(step.churn).toBeNull()
    expect(step.inputLabel).toBe("Captured content")
    expect(step.input).toEqual({ kind: "code", text: content, language: "ts", firstLine: 1 })
  })

  it("preserves empty and whitespace-only replacement text exactly", () => {
    const whitespace = describeToolCall(call("edit", { input: { path: "a.txt", old_str: " ", new_str: "\t" } }))
    expect(whitespace.input).toMatchObject({
      kind: "diff",
      rows: [
        { sign: "-", text: " " },
        { sign: "+", text: "\t" },
      ],
    })

    const empty = describeToolCall(call("edit", { input: { path: "a.txt", old_str: "x", new_str: "" } }))
    expect(empty.input).toMatchObject({ kind: "diff", rows: [{ sign: "-", text: "x" }] })
    expect(empty.churn).toEqual({ added: 0, removed: 1 })
  })

  it("keeps patch and multi-edit arguments inspectable", () => {
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch"
    const patchStep = describeToolCall(call("apply_patch", { input: { patch }, linesAdded: 1, linesRemoved: 1 }))
    expect(patchStep.inputLabel).toBe("Patch")
    expect(patchStep.input).toEqual({ kind: "text", text: patch })

    const edits = [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ]
    const multiStep = describeToolCall(call("multi_edit", { input: { path: "a.ts", edits } }))
    expect(multiStep.inputLabel).toBe("Changes")
    expect(multiStep.input).toEqual({ kind: "text", text: JSON.stringify(edits, null, 2) })
  })

  it("falls back to formatted input for an unrecognized edit payload", () => {
    const step = describeToolCall(call("edit_file", { input: { path: "a.ts", operations: [{ insert: "x" }] } }))
    expect(step.inputLabel).toBe("Input")
    expect(step.input).toEqual({
      kind: "text",
      text: '{\n  "path": "a.ts",\n  "operations": [\n    {\n      "insert": "x"\n    }\n  ]\n}',
    })
  })

  it("merges host churn independently with the derived opposite side", () => {
    const step = describeToolCall(
      call("edit", {
        input: { path: "a.ts", old_str: "one\ntwo", new_str: "ONE" },
        linesAdded: 4,
      }),
    )
    expect(step.churn).toEqual({ added: 4, removed: 2 })
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

  it("treats a captured empty string as no output measurement", () => {
    const step = describeToolCall(call("bash", { input: { command: "true" }, output: "" }))
    expect(step.stats).toMatchObject({ lines: null, bytes: null })
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
    expect(stripGutter("1. alpha\n2. beta\n3. gamma", "dotted")).toEqual({ text: "alpha\nbeta\ngamma", firstLine: 1 })
  })

  it("leaves content alone when valid gutter numbers descend", () => {
    const text = "5| alpha\n4| beta\n3| gamma"
    expect(stripGutter(text)).toEqual({ text, firstLine: 1 })
  })

  it("requires consecutive rather than merely increasing gutter numbers", () => {
    const text = "5| alpha\n7| beta\n9| gamma"
    expect(stripGutter(text)).toEqual({ text, firstLine: 1 })
  })

  it("strips one- and two-line gutters when their format is known", () => {
    expect(stripGutter("12| only")).toEqual({ text: "only", firstLine: 12 })
    expect(stripGutter("12. one\n13. two", "dotted")).toEqual({ text: "one\ntwo", firstLine: 12 })
  })

  it("excludes one trailing split-empty line from detection and preserves it", () => {
    expect(stripGutter("12| one\n13| two\n")).toEqual({ text: "one\ntwo\n", firstLine: 12 })
  })

  it("does not infer dotted gutters from arbitrary content", () => {
    const text = "1. First\n2. Second\n3. Third"
    expect(stripGutter(text)).toEqual({ text, firstLine: 1 })
  })
})

describe("diffLines", () => {
  it("represents a final-newline-only change explicitly and counts it as a replacement", () => {
    const rows = diffLines("foo", "foo\n")
    expect(rows).toEqual([
      { sign: "-", text: "foo" },
      { sign: "\\", text: "No newline at end of file" },
      { sign: "+", text: "foo" },
    ])
    expect(countChurn(rows)).toEqual({ added: 1, removed: 1 })
  })

  it("preserves content that ends with the old internal marker text", () => {
    const literal = "value\u0000observer:no-newline"
    expect(diffLines(literal, literal)).toEqual([{ sign: " ", text: literal }])
    expect(diffLines(literal, `${literal}\n`)).toEqual([
      { sign: "-", text: literal },
      { sign: "\\", text: "No newline at end of file" },
      { sign: "+", text: literal },
    ])
  })
})

describe("formatting", () => {
  it("removes only the synthetic final split segment", () => {
    expect(contentLines("one\n\n")).toEqual(["one", ""])
    expect(contentLines("one\n\n\n")).toEqual(["one", "", ""])
  })

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

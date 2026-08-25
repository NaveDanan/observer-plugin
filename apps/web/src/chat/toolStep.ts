import type { ToolCallEntity } from "@observer-ai/protocol"
import { isFileCreationTool, toolAction, type ToolAction } from "./timeline"

/**
 * What one tool call looks like when a reader is asked to understand it.
 *
 * A raw call is a tool name, a bag of arguments and a blob of output — three
 * things a host names differently and none of which reads as a *step*. This
 * module turns that into the sentence the transcript actually wants: what the
 * agent did (`Searched src/**\/*.ts`), how it went (`14 matches`), what it was
 * given, and what came back — as a file, a terminal, a list or plain text,
 * because a directory listing and a build log want very different chrome.
 *
 * Two rules keep it honest across hosts:
 *
 * **Argument names are looked up, never assumed.** OpenCode says `filePath`,
 * Copilot says `path`, Claude says `file_path`; a table keyed on one of them
 * silently degrades every other host to "used a tool". Every reader here takes
 * a list of aliases and the first one that holds a usable value wins.
 *
 * **Nothing is invented.** A count comes from output that exists or it is
 * omitted; a running call says so rather than showing an empty card. Absent is
 * not zero — the same rule the reducer applies to churn.
 *
 * Pure and React-free so the parts that are easy to get wrong — the titles,
 * the counts, the gutter stripping — can be tested directly.
 */

export type StepBody =
  /** File-ish content: line numbers down the side, syntax highlighted. */
  | { kind: "code"; text: string; language: string | undefined; firstLine: number }
  /** Command output: a terminal that preserves ANSI colour and text styles. */
  | { kind: "terminal"; text: string }
  /** One thing per line — paths, matches, todos. */
  | { kind: "list"; items: string[] }
  /** An edit, as a unified diff: context, removals and additions in order. */
  | { kind: "diff"; rows: DiffRow[]; language: string | undefined }
  /** Anything else, including JSON we pretty-printed on the way in. */
  | { kind: "text"; text: string }

/** One line of a unified diff: unchanged context, a removal, or an addition. */
export interface DiffRow {
  sign: " " | "-" | "+" | "\\"
  text: string
}

export interface StepField {
  label: string
  value: string
  /** Paths, patterns and commands are code; a task description is prose. */
  mono: boolean
}

export interface StepStats {
  startedAt: number
  durationMs: number | null
  /** Output size, or `null` when the call produced no output to measure. */
  lines: number | null
  bytes: number | null
}

export interface ToolStep {
  action: ToolAction
  /**
   * The tool's own name, shown in bold ahead of the title when the title is a
   * verbatim argument rather than a sentence: **Bash** `pnpm test` reads as
   * one line, where `pnpm test` alone leaves the reader to infer that a shell
   * was involved.
   */
  lead: string | null
  /** The collapsed row's sentence: "Read package.json", "Ran pnpm test". */
  title: string
  /** The figure that answers "how did it go?" — "14 matches", "exit 1". */
  meta: string | null
  /** The inputs worth naming, in the order they should be read. */
  fields: StepField[]
  /** The argument body — an edit's diff, a delegation's prompt. */
  input: StepBody | null
  /** A more precise heading than the action-derived default, when needed. */
  inputLabel: string | null
  /** What came back. */
  output: StepBody | null
  error: string | null
  /**
   * The one thing the step is *about*, shown as the card's title bar: the file
   * a read touched, the command a shell ran. Kept out of `fields` because a
   * card that names the file in its header and again under a "File" label is
   * saying the same thing twice in the space of two lines.
   */
  subject: { kind: "path" | "command"; value: string } | null
  /**
   * How much the file moved, when the step changed one: the `+7 −6` that says
   * at a glance whether this was a typo fix or a rewrite. Counted from the diff
   * when the host does not report it, because "an edit" with no size is the
   * one thing a reader always wants to know before opening the card.
   */
  churn: { added: number | null; removed: number | null } | null
  /** Per-file changes carried by a patch envelope, in envelope order. */
  patchFiles: PatchFileChange[] | null
  stats: StepStats
  running: boolean
  failed: boolean
}

export interface PatchFileChange {
  path: string
  operation: "add" | "delete" | "edit"
  added: number
  removed: number
}

// ------------------------------------------------------------------ lookups

const PATH_KEYS = ["filePath", "file_path", "path", "file", "target_file", "notebook_path", "absolute_path"]
const PATTERN_KEYS = ["pattern", "glob", "query", "regex", "search"]
const COMMAND_KEYS = ["command", "cmd", "script", "shell_command"]
const SCOPE_KEYS = ["paths", "include", "path_filter", "glob_filter", "directory", "dir", "cwd"]
const DESCRIPTION_KEYS = ["description", "title", "prompt_summary"]
const PROMPT_KEYS = ["prompt", "instructions", "task", "message"]
const AGENT_KEYS = ["subagent_type", "subagentType", "agent", "agent_type", "agentType", "task_name", "taskName"]
const RECIPIENT_KEYS = ["target", "to", "recipient"]
const URL_KEYS = ["url", "uri", "link"]
const OLD_KEYS = ["old_str", "oldString", "old_string", "oldText"]
const NEW_KEYS = ["new_str", "newString", "new_string", "newText", "content", "file_text", "text"]

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** The first alias that holds a non-empty string, trimmed of nothing. */
function str(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.trim().length > 0) return value
    // Copilot passes `paths` as either a string or an array of them.
    if (Array.isArray(value)) {
      const joined = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).join(", ")
      if (joined.length > 0) return joined
    }
  }
  return null
}

/** Source text is exact: empty and whitespace-only strings are still present. */
function exactText(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string") return value
  }
  return null
}

function num(input: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

/**
 * The `a-b` a read was limited to, however the host expresses it.
 *
 * Copilot sends `view_range: [1, 180]`, OpenCode sends `offset` and `limit`.
 * Both mean the same thing to a reader and to the line gutter, so both are
 * normalised to a first line and an optional last one.
 */
function readRange(input: Record<string, unknown>): { from: number; to: number | null } | null {
  const range = input["view_range"] ?? input["viewRange"] ?? input["range"]
  if (Array.isArray(range)) {
    const [from, to] = range
    if (typeof from === "number") return { from, to: typeof to === "number" && to !== -1 ? to : null }
  }
  const offset = num(input, ["offset", "start_line", "startLine"])
  const limit = num(input, ["limit", "line_count", "lineCount"])
  if (offset === null && limit === null) return null
  const from = offset ?? 1
  return { from, to: limit === null ? null : from + limit - 1 }
}

// ------------------------------------------------------------------ shaping

/** The file name, which is what a step row has room for. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "")
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/** Long values get an ellipsis rather than a row that wraps to three lines. */
export function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * Shiki's id for a file extension, or `undefined` to let it fall back to text.
 *
 * Deliberately short: the point is that the common files in a repository look
 * like themselves, not that this mirrors Shiki's alias table.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  mdx: "mdx",
  css: "css",
  scss: "scss",
  html: "html",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  sql: "sql",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  ini: "ini",
  env: "ini",
  lua: "lua",
  vue: "vue",
  svelte: "svelte",
}

export function languageForPath(path: string | null): string | undefined {
  if (!path) return undefined
  const name = baseName(path).toLowerCase()
  if (name === "dockerfile") return "docker"
  if (name === "makefile") return "make"
  const dot = name.lastIndexOf(".")
  if (dot === -1) return undefined
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1)]
}

/**
 * Strips a host's line-number gutter off file content, keeping the numbers.
 *
 * Every host that reads a file hands the model a numbered listing —
 * `00001| text` from OpenCode, `1. text` from Copilot — and rendering that
 * verbatim gives the reader two gutters, one of which is wrong as soon as the
 * read was ranged. Recovering the first line number instead means the viewer's
 * own gutter can start where the file actually was read.
 *
 * Conservative on purpose. Dotted gutters require an explicit host/tool
 * signal because they are indistinguishable from Markdown ordered lists.
 * Every format also requires nearly every line to carry consecutive numbers.
 */
export type GutterFormat = "none" | "dotted" | "unambiguous"

export function stripGutter(text: string, format: GutterFormat = "unambiguous"): { text: string; firstLine: number } {
  if (format === "none") return { text, firstLine: 1 }
  const allLines = text.split("\n")
  const hasFinalNewline = allLines.at(-1) === ""
  const candidates = hasFinalNewline ? allLines.slice(0, -1) : allLines
  if (candidates.length === 0) return { text, firstLine: 1 }
  const pattern =
    format === "dotted" ? /^\s{0,8}(\d{1,6})\. ?(.*)$/ : /^\s{0,8}(\d{1,6})(?:\||:|\t) ?(.*)$/
  const nonBlankCandidates = candidates.filter((line) => line.trim().length > 0).length
  const numbers: number[] = []
  const stripped: string[] = []
  let matched = 0
  for (const line of candidates) {
    const found = pattern.exec(line)
    if (found?.[1] === undefined) {
      // A blank line inside a listing is legitimately unnumbered in some hosts.
      stripped.push(line)
      numbers.push(Number.NaN)
      continue
    }
    matched++
    numbers.push(Number(found[1]))
    stripped.push(found[2] ?? "")
  }
  if (matched < nonBlankCandidates * 0.8) return { text, firstLine: 1 }
  const real = numbers.filter((value) => !Number.isNaN(value))
  let expected: number | null = null
  const consecutive = numbers.every((value) => {
    if (Number.isNaN(value)) {
      if (expected !== null) expected += 1
      return true
    }
    if (expected === null) {
      expected = value + 1
      return true
    }
    if (value !== expected) return false
    expected += 1
    return true
  })
  if (!consecutive || real.length === 0) return { text, firstLine: 1 }
  if (hasFinalNewline) stripped.push("")
  return { text: stripped.join("\n"), firstLine: real[0] as number }
}

/** OpenCode wraps read output in `<file>` tags; they are chrome, not content. */
function unwrapFile(text: string): string {
  const match = /^<file>\n?([\s\S]*?)\n?<\/file>\s*$/.exec(text.trim())
  return match?.[1] ?? text
}

export function contentLines(text: string): string[] {
  if (text === "") return []
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n")
}

function nonEmptyLines(text: string): string[] {
  return contentLines(text).filter((line) => line.trim().length > 0)
}

// ---------------------------------------------------------------- formatting

/**
 * The lines an edit took out and put in, interleaved with the context around
 * them.
 *
 * Hosts hand over the before and after text of a replacement, never a diff, so
 * the diff has to be computed here — and showing the two versions as separate
 * blocks makes the reader compare them by eye, which is exactly the work a diff
 * exists to remove.
 *
 * Common prefix and suffix are stripped first: most edits change one line in
 * the middle of a hunk, and trimming turns a 60×60 comparison into a 1×1 one.
 * The quadratic table is only reached for what is left, and only while it fits
 * inside `DIFF_CELL_LIMIT` — past that the middle is reported as a wholesale
 * replacement, which is both true and cheap, rather than freezing the panel to
 * align two thousand lines nobody will read line by line.
 */
export function diffLines(before: string, after: string): DiffRow[] {
  const beforeLines = splitForDiff(before)
  const afterLines = splitForDiff(after)
  let a = beforeLines.lines.map((text) => ({ text, noNewline: false }))
  let b = afterLines.lines.map((text) => ({ text, noNewline: false }))
  if (!beforeLines.endsWithNewline && a.length > 0) {
    a = [...a.slice(0, -1), { text: (a.at(-1) as DiffInputLine).text, noNewline: true }]
  }
  if (!afterLines.endsWithNewline && b.length > 0) {
    b = [...b.slice(0, -1), { text: (b.at(-1) as DiffInputLine).text, noNewline: true }]
  }

  let head = 0
  while (head < a.length && head < b.length && sameDiffLine(a[head] as DiffInputLine, b[head] as DiffInputLine)) head += 1
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    sameDiffLine(a[a.length - 1 - tail] as DiffInputLine, b[b.length - 1 - tail] as DiffInputLine)
  ) {
    tail += 1
  }

  const context = (line: DiffInputLine): PendingDiffRow => ({ sign: " ", ...line })
  return expandNoNewlineMarkers([
    ...a.slice(0, head).map(context),
    ...alignLines(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map(context),
  ])
}

const DIFF_CELL_LIMIT = 250_000

interface DiffInputLine {
  text: string
  noNewline: boolean
}

type PendingDiffRow = DiffRow & { noNewline: boolean }

function splitForDiff(text: string): { lines: string[]; endsWithNewline: boolean } {
  if (text === "") return { lines: [], endsWithNewline: false }
  const endsWithNewline = text.endsWith("\n")
  const body = endsWithNewline ? text.slice(0, -1) : text
  return { lines: body.split("\n"), endsWithNewline }
}

function sameDiffLine(a: DiffInputLine, b: DiffInputLine): boolean {
  return a.text === b.text && a.noNewline === b.noNewline
}

function expandNoNewlineMarkers(rows: PendingDiffRow[]): DiffRow[] {
  return rows.flatMap((row) => {
    const content: DiffRow = { sign: row.sign, text: row.text }
    if (!row.noNewline) return [content]
    return [
      content,
      { sign: "\\", text: "No newline at end of file" },
    ]
  })
}

function alignLines(a: DiffInputLine[], b: DiffInputLine[]): PendingDiffRow[] {
  const removed = (line: DiffInputLine): PendingDiffRow => ({ sign: "-", ...line })
  const added = (line: DiffInputLine): PendingDiffRow => ({ sign: "+", ...line })
  if (a.length === 0) return b.map(added)
  if (b.length === 0) return a.map(removed)
  if (a.length * b.length > DIFF_CELL_LIMIT) return [...a.map(removed), ...b.map(added)]

  // Longest common subsequence, filled backwards so the walk below runs
  // forwards and emits rows in reading order.
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  const at = (i: number, j: number): number => table[i * width + j] as number
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        sameDiffLine(a[i] as DiffInputLine, b[j] as DiffInputLine)
          ? at(i + 1, j + 1) + 1
          : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }

  const rows: PendingDiffRow[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (sameDiffLine(a[i] as DiffInputLine, b[j] as DiffInputLine)) {
      rows.push({ sign: " ", ...(a[i] as DiffInputLine) })
      i += 1
      j += 1
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      // Removals lead their replacements, the way every diff tool prints them.
      rows.push(removed(a[i] as DiffInputLine))
      i += 1
    } else {
      rows.push(added(b[j] as DiffInputLine))
      j += 1
    }
  }
  while (i < a.length) rows.push(removed(a[i++] as DiffInputLine))
  while (j < b.length) rows.push(added(b[j++] as DiffInputLine))
  return rows
}

/** `run_in_terminal` reads as "Run in terminal"; `bash` stays "Bash". */
export function prettyTool(tool: string): string {
  const words = tool.replace(/[_-]+/g, " ").trim()
  if (words === "") return tool
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function countChurn(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const row of rows) {
    if (row.sign === "+") added += 1
    else if (row.sign === "-") removed += 1
  }
  return { added, removed }
}

/** Milliseconds are the right unit until they stop being readable. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const roundedTenths = Math.round(ms / 100)
  if (roundedTenths < 600) return `${(roundedTenths / 10).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1000)
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatCount(count: number, noun: string): string {
  // "matches", not "matchs". Narrow on purpose: the nouns here are a closed
  // set (line, file, match, task, command), and a general pluraliser would be
  // a lot of machinery for five words.
  const plural = /(?:s|x|z|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`
  return `${count} ${count === 1 ? noun : plural}`
}

/** "Aug 23, 2026 · 1:29 AM" — a date a reader can match against a log. */
export function formatStarted(at: number): string {
  const date = new Date(at)
  return `${date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })} · ${date.toLocaleTimeString(
    [],
    { hour: "numeric", minute: "2-digit" },
  )}`
}

// ------------------------------------------------------------------ describe

/**
 * The exit code a shell tool reported, when it reported one.
 *
 * Hosts differ on where it lives — a field on the result object, or a trailing
 * line in the text — so both are read. A zero is as worth saying as a one:
 * "exit 0" is the only positive confirmation a silent command succeeded.
 */
function exitCode(call: ToolCallEntity): number | null {
  const meta = record(call.input)
  const fromInput = num(meta, ["exit_code", "exitCode"])
  if (fromInput !== null) return fromInput
  if (!call.output) return null
  const match = /(?:^|\n)\s*(?:<shellId:[^>]*exit code (\d+)>|exit(?: code)?[: ]\s*(\d+))\s*$/i.exec(call.output)
  const found = match?.[1] ?? match?.[2]
  return found === undefined ? null : Number(found)
}

/**
 * One tool call, as a step.
 *
 * A host-supplied title always wins for the row's sentence — OpenCode composes
 * a good one and second-guessing it would be a regression — but everything
 * else is derived, because no host supplies it.
 */
export function describeToolCall(call: ToolCallEntity): ToolStep {
  const action = toolAction(call.tool)
  const input = record(call.input)
  const path = str(input, PATH_KEYS)
  const output = call.output ?? null
  const running = call.status === "running"
  const failed = call.status === "error"

  const step: ToolStep = {
    action,
    lead: null,
    title: call.title ?? call.tool,
    meta: null,
    fields: [],
    input: null,
    inputLabel: null,
    output: null,
    error: call.error,
    subject: path ? { kind: "path", value: path } : null,
    churn: null,
    patchFiles: null,
    stats: {
      startedAt: call.startedAt,
      durationMs: call.durationMs,
      lines: output === null || output === "" ? null : contentLines(output).length,
      bytes: output === null || output === "" ? null : byteLength(output),
    },
    running,
    failed,
  }

  switch (action) {
    case "command": {
      const command = str(input, COMMAND_KEYS)
      const description = str(input, DESCRIPTION_KEYS)
      step.title = call.title ?? (command ? truncate(command, 72) : call.tool)
      // Without a host title the row is the command itself, which needs the
      // tool's name in front of it to read as a sentence.
      if (!call.title && command) step.lead = prettyTool(call.tool)
      if (command) step.subject = { kind: "command", value: command }
      if (description) step.fields.push({ label: "Purpose", value: description, mono: false })
      const code = exitCode(call)
      step.meta = code !== null ? `exit ${code}` : failed ? "failed" : durationMeta(call)
      if (output) step.output = { kind: "terminal", text: output }
      break
    }

    case "search": {
      const pattern = str(input, PATTERN_KEYS)
      const scope = str(input, SCOPE_KEYS)
      step.title = call.title ?? (pattern ? `Searched ${truncate(pattern, 56)}` : `Searched with ${call.tool}`)
      if (pattern) step.fields.push({ label: "Pattern", value: pattern, mono: true })
      if (scope) step.fields.push({ label: "In", value: scope, mono: true })
      if (output !== null) {
        const found = nonEmptyLines(output)
        // A search that found nothing is a result, not an empty card — and the
        // noun follows the tool: a glob returns files, a grep returns matches.
        const noun = call.tool.toLowerCase().includes("glob") ? "file" : "match"
        step.meta = formatCount(found.length, noun)
        if (found.length > 0) step.output = { kind: "list", items: found }
        else if (!failed) step.output = { kind: "text", text: "No matches." }
      }
      break
    }

    case "read": {
      const url = str(input, URL_KEYS)
      const range = readRange(input)
      const suffix = range ? `:${range.from}-${range.to ?? ""}`.replace(/-$/, "") : ""
      step.title =
        call.title ?? (path ? `Read ${baseName(path)}${suffix}` : url ? `Fetched ${truncate(url, 56)}` : call.tool)
      if (url) step.fields.push({ label: "URL", value: url, mono: true })
      if (range) {
        step.fields.push({ label: "Lines", value: range.to === null ? `from ${range.from}` : `${range.from}–${range.to}`, mono: true })
      }
      if (output !== null) {
        const body = stripGutter(unwrapFile(output), readGutterFormat(call.tool, input))
        step.meta = formatCount(contentLines(body.text).length, "line")
        step.output = {
          kind: "code",
          text: body.text,
          language: languageForPath(path),
          // A ranged read whose host did not number its output still starts
          // where it was asked to start.
          firstLine: body.firstLine > 1 ? body.firstLine : (range?.from ?? 1),
        }
      }
      break
    }

    case "edit": {
      const family = editFamily(call.tool)
      let derivedChurn: ToolStep["churn"] = null

      if (family === "write" || family === "create") {
        const content = exactText(input, NEW_KEYS)
        const verb = family === "create" ? "Create" : "Write"
        step.title = call.title ?? (path ? `${verb} ${baseName(path)}` : prettyTool(call.tool))
        if (content !== null && family === "create" && !hasIncompletePayload(content)) {
          const rows = diffLines("", content)
          step.input = { kind: "diff", rows, language: languageForPath(path) }
          step.inputLabel = "Change"
          derivedChurn = countChurn(rows)
        } else if (content !== null && family === "create") {
          step.input = { kind: "code", text: content, language: languageForPath(path), firstLine: 1 }
          step.inputLabel = "Captured content"
        } else if (content !== null) {
          step.input = { kind: "code", text: content, language: languageForPath(path), firstLine: 1 }
          step.inputLabel = "New content"
        }
      } else if (family === "patch") {
        const patch = exactText(input, ["patch", "patchText", "patch_text", "diff", "content", "input"])
        step.title = call.title ?? (path ? `Patch ${baseName(path)}` : prettyTool(call.tool))
        if (patch !== null) {
          const files = parsePatchFiles(patch)
          if (files.length > 0) {
            step.patchFiles = files
            derivedChurn = files.reduce(
              (total, file) => ({ added: total.added + file.added, removed: total.removed + file.removed }),
              { added: 0, removed: 0 },
            )
            step.title = call.title ?? `${formatCount(files.length, "file")} edited`
          } else {
            step.input = { kind: "text", text: patch }
            step.inputLabel = "Patch"
          }
        }
      } else if (family === "multiedit") {
        step.title = call.title ?? (path ? `Edit ${baseName(path)}` : prettyTool(call.tool))
        const printed = printInput(input["edits"])
        if (printed !== null) {
          step.input = { kind: "text", text: printed }
          step.inputLabel = "Changes"
        }
      } else {
        const removed = exactText(input, OLD_KEYS)
        const added = exactText(input, NEW_KEYS)
        step.title = call.title ?? (path ? `Edit ${baseName(path)}` : call.tool)
        if (removed !== null && added !== null) {
          const rows = diffLines(removed, added)
          step.input = { kind: "diff", rows, language: languageForPath(path) }
          step.inputLabel = "Change"
          if (!hasIncompletePayload(removed) && !hasIncompletePayload(added)) derivedChurn = countChurn(rows)
        } else if (added !== null) {
          step.input = { kind: "code", text: added, language: languageForPath(path), firstLine: 1 }
          step.inputLabel = "New content"
          if (!hasIncompletePayload(added)) derivedChurn = { added: contentLines(added).length, removed: null }
        } else if (removed !== null) {
          step.input = { kind: "code", text: removed, language: languageForPath(path), firstLine: 1 }
          step.inputLabel = "Previous content"
          if (!hasIncompletePayload(removed)) derivedChurn = { added: null, removed: contentLines(removed).length }
        }
      }

      if (step.input === null && step.patchFiles === null) {
        const printed = printInput(call.input)
        if (printed !== null) {
          step.input = { kind: "text", text: printed }
          step.inputLabel = "Input"
        }
      }
      step.churn = mergeChurn(call, derivedChurn)
      step.meta = step.churn === null ? durationMeta(call) : null
      if (output) step.output = { kind: "text", text: output }
      break
    }

    case "task": {
      const agent = str(input, AGENT_KEYS)
      const description = str(input, DESCRIPTION_KEYS)
      step.title = call.title ?? (description ?? (agent ? `Delegated to ${agent}` : call.tool))
      if (agent) step.fields.push({ label: "Agent", value: agent, mono: true })
      if (description) step.fields.push({ label: "Task", value: description, mono: false })
      const prompt = str(input, PROMPT_KEYS)
      if (prompt) step.input = { kind: "text", text: prompt }
      step.meta = durationMeta(call)
      if (output) step.output = { kind: "text", text: output }
      break
    }

    case "message": {
      const recipient = str(input, RECIPIENT_KEYS)
      const message = str(input, PROMPT_KEYS)
      step.title = call.title ?? (recipient ? `Messaged ${recipient}` : "Sent a message")
      if (recipient) step.fields.push({ label: "Recipient", value: recipient, mono: true })
      if (message) step.input = { kind: "text", text: message }
      step.meta = durationMeta(call)
      if (output) step.output = { kind: "text", text: output }
      break
    }

    case "todo": {
      const todos = Array.isArray(input["todos"]) ? input["todos"] : []
      const items = todos.map((entry) => {
        const todo = record(entry)
        const content = str(todo, ["content", "title", "text", "description"]) ?? ""
        const status = str(todo, ["status", "state"]) ?? "pending"
        return `${MARKER[status] ?? "○"} ${content}`
      })
      step.title = call.title ?? "Updated the task list"
      step.meta = items.length > 0 ? formatCount(items.length, "task") : durationMeta(call)
      if (items.length > 0) step.input = { kind: "list", items }
      else if (output) step.output = { kind: "text", text: output }
      break
    }

    default: {
      step.title = call.title ?? call.tool
      const subject = path ?? str(input, PATTERN_KEYS) ?? str(input, URL_KEYS)
      if (subject) step.fields.push({ label: "Input", value: subject, mono: true })
      else {
        const printed = printInput(call.input)
        if (printed) step.input = { kind: "text", text: printed }
      }
      step.meta = durationMeta(call)
      if (output) step.output = looksLikeJson(output) ? { kind: "text", text: output } : { kind: "terminal", text: output }
      break
    }
  }

  // A call still in flight has no output *yet*, which is a different claim
  // from having produced none — the row says so instead of showing "0 lines".
  if (running && step.meta === null) step.meta = "running"
  if (failed) {
    const code = action === "command" ? exitCode(call) : null
    step.meta = code === null ? "failed" : `failed · exit ${code}`
  }
  return step
}

/** Parses apply_patch's file directives without treating its envelope as tool chrome. */
export function parsePatchFiles(patch: string): PatchFileChange[] {
  const files: PatchFileChange[] = []
  let current: PatchFileChange | null = null

  for (const line of patch.split("\n")) {
    const directive = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line)
    if (directive) {
      const operation = directive[1] === "Add" ? "add" : directive[1] === "Delete" ? "delete" : "edit"
      current = { path: (directive[2] as string).trimEnd(), operation, added: 0, removed: 0 }
      files.push(current)
      continue
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (move && current) {
      current.path = (move[1] as string).trimEnd()
      continue
    }
    if (line.startsWith("*** ")) {
      current = null
      continue
    }
    if (!current) continue
    if (line.startsWith("+") && !line.startsWith("+++")) current.added += 1
    else if (line.startsWith("-") && !line.startsWith("---")) current.removed += 1
  }

  return files
}

const MARKER: Record<string, string> = {
  completed: "✓",
  done: "✓",
  in_progress: "◐",
  running: "◐",
  pending: "○",
  cancelled: "✗",
}

function durationMeta(call: ToolCallEntity): string | null {
  return call.durationMs === null ? null : formatDuration(call.durationMs)
}

/**
 * The churn the host measured, which beats anything counted from the
 * arguments: a host watching the file system sees the whole write, where the
 * arguments only show the hunk that was sent.
 */
function mergeChurn(call: ToolCallEntity, derived: ToolStep["churn"]): ToolStep["churn"] {
  const added = call.linesAdded ?? derived?.added ?? null
  const removed = call.linesRemoved ?? derived?.removed ?? null
  return added === null && removed === null ? null : { added, removed }
}

function normaliseToolName(tool: string): string {
  return tool.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function editFamily(tool: string): "create" | "multiedit" | "patch" | "replace" | "write" {
  const name = normaliseToolName(tool)
  if (isFileCreationTool(tool)) return "create"
  if (name === "write" || name === "writefile" || name === "filewrite") return "write"
  if (name === "multiedit") return "multiedit"
  if (name === "applypatch" || name === "patch") return "patch"
  return "replace"
}

const INCOMPLETE_PAYLOAD_MARKERS = ["[redacted]", "\u2026 [truncated ", "[depth limit]"]

function hasIncompletePayload(text: string): boolean {
  return INCOMPLETE_PAYLOAD_MARKERS.some((marker) => text.includes(marker))
}

function readGutterFormat(tool: string, input: Record<string, unknown>): GutterFormat {
  const declared = str(input, ["gutter_format", "gutterFormat", "line_number_format", "lineNumberFormat"])?.toLowerCase()
  if (declared === "dotted" || declared === "unambiguous" || declared === "none") return declared
  const name = normaliseToolName(tool)
  if (name === "view" || name === "viewfile") return "dotted"
  if (name === "read" || name === "readfile") return "unambiguous"
  return "none"
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))
}

function printInput(input: unknown): string | null {
  if (input === null || input === undefined) return null
  if (typeof input === "string") return input.length > 0 ? input : null
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    // Circular or otherwise unserialisable payloads must not take the panel
    // down with them.
    return String(input)
  }
}

/** UTF-8 size, which is what "369 B" in the footer claims to be. */
function byteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length
  return text.length
}

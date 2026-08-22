import type { MessageEntity, ToolCallEntity } from "@observer-ai/protocol"

/**
 * Turning a session's messages and tool calls into one ordered transcript.
 *
 * Tool calls used to live in a sibling tab, which made the two halves of a
 * turn impossible to line up: the panel could tell you the agent said "let me
 * check the config" and, separately, that it read four files, but never that
 * those were the same moment. Interleaving them answers "why did it do that?"
 * in the place the question is asked.
 *
 * Kept pure and free of React so the ordering and grouping rules — the parts
 * that are actually easy to get wrong — can be tested directly.
 */

export type ToolAction = "read" | "edit" | "command" | "search" | "task" | "todo" | "other"

export type TimelineRow =
  | {
      kind: "message"
      id: string
      at: number
      message: MessageEntity
      /** Continues the row above: same speaker, close in time, nothing between. */
      grouped: boolean
    }
  | {
      kind: "tools"
      id: string
      at: number
      /** One uninterrupted run of tool calls, in the order they started. */
      calls: ToolCallEntity[]
      action: ToolAction
      /** "Read 4 files", "Ran 2 commands". */
      summary: string
      failed: boolean
      running: boolean
    }

/** Consecutive turns from one speaker read as one message inside this window. */
const GROUPING_WINDOW_MS = 120_000

/**
 * Merges the two streams into one row list.
 *
 * The merge is by timestamp but **stable within each input**: messages keep
 * their `seq` order and tool calls keep their `startedAt` order no matter what
 * the clocks say. That matters because the two streams are stamped by
 * different parts of the host and routinely disagree by a few milliseconds —
 * sorting the union by time alone lets that noise reorder two messages, which
 * is a visible lie about what the agent said first. Timestamps decide only
 * where one stream interleaves with the *other*.
 *
 * A tool call is placed by when it *started*, not when it finished, so a slow
 * command stays next to the sentence that explains it rather than jumping past
 * the next three messages when it returns.
 */
export function buildTimeline(messages: MessageEntity[], toolCalls: ToolCallEntity[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  let messageIndex = 0
  let toolIndex = 0

  while (messageIndex < messages.length || toolIndex < toolCalls.length) {
    const message = messages[messageIndex]
    const call = toolCalls[toolIndex]

    // Ties go to the message. A tool call and the sentence announcing it share
    // a millisecond often enough to matter, and "I'll read the config" before
    // the read is the order the reader expects.
    const takeMessage = message !== undefined && (call === undefined || message.createdAt <= call.startedAt)

    if (takeMessage && message) {
      const previous = rows[rows.length - 1]
      const grouped =
        previous?.kind === "message" &&
        previous.message.role === message.role &&
        message.createdAt - previous.message.updatedAt < GROUPING_WINDOW_MS
      rows.push({ kind: "message", id: message.id, at: message.createdAt, message, grouped })
      messageIndex++
      continue
    }

    if (!call) break

    // Absorb the whole contiguous run of tool calls that belongs before the
    // next message, so twelve reads are one collapsed row rather than twelve
    // rows the reader has to scroll past to find the reply.
    const run: ToolCallEntity[] = []
    while (toolIndex < toolCalls.length) {
      const next = toolCalls[toolIndex]
      if (!next) break
      const nextMessage = messages[messageIndex]
      if (nextMessage && nextMessage.createdAt <= next.startedAt) break
      run.push(next)
      toolIndex++
    }
    if (run.length === 0) break

    const first = run[0]
    if (!first) break
    rows.push({
      kind: "tools",
      id: `tools:${first.id}`,
      at: first.startedAt,
      calls: run,
      action: runAction(run),
      summary: summarise(run),
      failed: run.some((entry) => entry.status === "error"),
      running: run.some((entry) => entry.status === "running"),
    })
  }

  return rows
}

/**
 * What a tool name means, in the vocabulary the summary line speaks.
 *
 * Matched on the normalised name rather than an exact table because every host
 * spells these differently — `read`, `Read`, `read_file`, `str_replace_editor`
 * — and a table would silently degrade to "Used 3 tools" for any host not
 * enumerated in it. Order matters: the more specific tests come first, so
 * `todowrite` is a todo rather than an edit.
 */
export function toolAction(tool: string): ToolAction {
  const name = tool.toLowerCase()
  if (name.includes("todo")) return "todo"
  if (name.includes("task") || name.includes("agent") || name.includes("subagent")) return "task"
  if (name.includes("grep") || name.includes("glob") || name.includes("search") || name.includes("find")) {
    return "search"
  }
  if (name.includes("bash") || name.includes("shell") || name.includes("exec") || name.includes("terminal")) {
    return "command"
  }
  if (name.includes("edit") || name.includes("write") || name.includes("patch") || name.includes("apply")) {
    return "edit"
  }
  if (name.includes("read") || name.includes("view") || name.includes("fetch") || name.includes("cat")) return "read"
  return "other"
}

/** A run's action, or `other` when it mixes several — a mixed run has no verb. */
function runAction(run: ToolCallEntity[]): ToolAction {
  const first = run[0]
  if (!first) return "other"
  const action = toolAction(first.tool)
  return run.every((entry) => toolAction(entry.tool) === action) ? action : "other"
}

const VERBS: Record<ToolAction, { one: string; many: string; noun: string }> = {
  read: { one: "Read", many: "Read", noun: "file" },
  edit: { one: "Edited", many: "Edited", noun: "file" },
  command: { one: "Ran", many: "Ran", noun: "command" },
  search: { one: "Searched", many: "Searched", noun: "time" },
  task: { one: "Delegated", many: "Delegated", noun: "task" },
  todo: { one: "Updated", many: "Updated", noun: "task list" },
  other: { one: "Used", many: "Used", noun: "tool" },
}

/**
 * The collapsed line for a run.
 *
 * A single call names its tool outright — "bash" is more useful than "Ran 1
 * command" when there is only one — and a run counts instead, because at four
 * calls the names stop fitting and start being noise.
 */
export function summarise(run: ToolCallEntity[]): string {
  const first = run[0]
  if (!first) return ""
  if (run.length === 1) return first.title ?? first.tool
  const action = runAction(run)
  const verb = VERBS[action]
  // Reads and edits of the same path twice are one file touched twice, not two
  // files; counting them separately overstates the blast radius of a turn.
  const count = action === "read" || action === "edit" ? new Set(run.map(subject)).size : run.length
  return `${count === 1 ? verb.one : verb.many} ${count} ${verb.noun}${count === 1 ? "" : "s"}`
}

/** The thing a call acted on — a path where there is one, else the call itself. */
function subject(call: ToolCallEntity): string {
  const input = call.input
  if (input && typeof input === "object") {
    for (const key of ["filePath", "file_path", "path", "file"]) {
      const value = (input as Record<string, unknown>)[key]
      if (typeof value === "string" && value.length > 0) return value
    }
  }
  return call.id
}

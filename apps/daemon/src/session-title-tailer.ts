import { createHash } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { SessionEntity } from "@observer-ai/protocol"
import type { Store } from "@observer-ai/storage"
import type { Pipeline } from "./pipeline.js"

const CLAUDE_READ_CAP = 4_000_000

interface ClaudeTitleState {
  path: string
  offset: number
  partial: string
  customTitle?: string
  aiTitle?: string
  lastPrompt?: string
  summary?: string
  firstPrompt?: string
}

interface ClaudeIndexTitle {
  customTitle?: string
  aiTitle?: string
  summary?: string
  firstPrompt?: string
}

/**
 * Copies each harness's own session name into Observer's session projection.
 *
 * Hook payloads do not carry a title consistently. The native session stores
 * do, and they also record renames that happen while the harness is idle. This
 * reader is deliberately one-way: Observer can display those names but never
 * writes back to a harness.
 */
export class SessionTitleTailer {
  private timer: NodeJS.Timeout | undefined
  private readonly claude = new Map<string, ClaudeTitleState>()

  constructor(
    private readonly store: Store,
    private readonly pipeline: Pipeline,
    private readonly intervalMs = 1_000,
  ) {}

  start(): void {
    if (this.timer) return
    try {
      this.tick()
    } catch {
      // Title recovery is best effort. Hook ingestion must keep running.
    }
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch {
        // A malformed or temporarily locked harness file is not fatal.
      }
    }, this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Exposed for deterministic tests and startup catch-up. */
  tick(): number {
    const codex = codexTitles()
    const claudeIndexes = new Map<string, Map<string, ClaudeIndexTitle>>()
    let accepted = 0

    for (const session of this.store.listSessions({ limit: 100 })) {
      const title = this.titleFor(session, codex, claudeIndexes)
      if (!title || title === session.title?.trim()) continue

      accepted += this.pipeline.ingestEvents([
        {
          id: titleEventId(session, title),
          host: session.host,
          hostVersion: session.hostVersion ?? undefined,
          adapter: `${session.host}-session-title@1`,
          workspaceRoot: session.workspaceRoot,
          sessionKey: session.sessionKey,
          agentKey: "main",
          at: Date.now(),
          provenance: "authoritative",
          body: { kind: "session.title", title },
        },
      ]).accepted
    }

    return accepted
  }

  private titleFor(
    session: SessionEntity,
    codex: Map<string, string>,
    claudeIndexes: Map<string, Map<string, ClaudeIndexTitle>>,
  ): string | undefined {
    switch (session.host) {
      case "opencode":
        return cleanTitle(session.title)
      case "codex":
        return codex.get(session.sessionKey)
      case "copilot":
        return copilotTitle(session.sessionKey)
      case "claude":
        return this.claudeTitle(session, claudeIndexes)
    }
  }

  private claudeTitle(
    session: SessionEntity,
    indexes: Map<string, Map<string, ClaudeIndexTitle>>,
  ): string | undefined {
    let state = this.claude.get(session.sessionKey)
    if (!state) {
      const path = findClaudeTranscript(session)
      if (!path) return undefined
      state = { path, offset: 0, partial: "" }
      this.claude.set(session.sessionKey, state)
    }

    readClaudeTitleLines(state)
    const index = claudeIndex(dirname(state.path), indexes).get(session.sessionKey)
    return firstTitle(
      state.customTitle,
      index?.customTitle,
      state.aiTitle,
      index?.aiTitle,
      state.lastPrompt,
      state.summary,
      index?.summary,
      state.firstPrompt,
      index?.firstPrompt,
    )
  }
}

function titleEventId(session: SessionEntity, title: string): string {
  const digest = createHash("sha1").update(title).digest("hex").slice(0, 20)
  return `session-title:${session.host}:${session.sessionKey}:${digest}`
}

function configuredHome(variable: string, fallback: string): string {
  const configured = process.env[variable]
  return configured && configured.trim().length > 0 ? configured.trim() : join(homedir(), fallback)
}

function codexTitles(): Map<string, string> {
  const titles = new Map<string, string>()
  const path = join(configuredHome("CODEX_HOME", ".codex"), "session_index.jsonl")
  if (!existsSync(path)) return titles

  let source: string
  try {
    source = readFileSync(path, "utf8")
  } catch {
    return titles
  }
  for (const line of source.split("\n")) {
    const record = jsonRecord(line)
    const id = stringField(record, "id")
    const title = firstTitle(stringField(record, "thread_name"), stringField(record, "title"))
    if (id && title) titles.set(id, title)
  }
  return titles
}

function copilotTitle(sessionKey: string): string | undefined {
  const path = join(configuredHome("COPILOT_HOME", ".copilot"), "session-state", sessionKey, "workspace.yaml")
  if (!existsSync(path)) return undefined

  let source: string
  try {
    source = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  for (const line of source.split(/\r?\n/)) {
    const match = /^name:\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    return yamlScalar(match[1] ?? "")
  }
  return undefined
}

function yamlScalar(source: string): string | undefined {
  const value = source.trim()
  if (!value || value === "null" || value === "~" || value === "|" || value === ">") return undefined
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return cleanTitle(JSON.parse(value))
    } catch {
      return undefined
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return cleanTitle(value.slice(1, -1).replace(/''/g, "'"))
  const comment = value.indexOf(" #")
  return cleanTitle(comment >= 0 ? value.slice(0, comment) : value)
}

function findClaudeTranscript(session: SessionEntity): string | undefined {
  const root = join(configuredHome("CLAUDE_CONFIG_DIR", ".claude"), "projects")
  const cwd = session.cwd ?? session.workspaceRoot
  if (cwd) {
    const direct = join(root, encodeClaudeProjectPath(cwd), `${session.sessionKey}.jsonl`)
    if (existsSync(direct)) return direct
  }
  if (!existsSync(root)) return undefined

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name, `${session.sessionKey}.jsonl`)
      if (existsSync(path)) return path
    }
  } catch {
    return undefined
  }
  return undefined
}

export function encodeClaudeProjectPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, "-")
}

function readClaudeTitleLines(state: ClaudeTitleState): void {
  let size: number
  try {
    size = statSync(state.path).size
  } catch {
    return
  }
  if (size < state.offset) resetClaudeState(state)
  if (size === state.offset) return

  const length = Math.min(size - state.offset, CLAUDE_READ_CAP)
  const buffer = Buffer.allocUnsafe(length)
  let read = 0
  let fd: number | undefined
  try {
    fd = openSync(state.path, "r")
    read = readSync(fd, buffer, 0, length, state.offset)
  } catch {
    return
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  state.offset += read

  const lines = (state.partial + buffer.subarray(0, read).toString("utf8")).split("\n")
  state.partial = lines.pop() ?? ""
  for (const line of lines) readClaudeTitleLine(state, line)
}

function resetClaudeState(state: ClaudeTitleState): void {
  state.offset = 0
  state.partial = ""
  state.customTitle = undefined
  state.aiTitle = undefined
  state.lastPrompt = undefined
  state.summary = undefined
  state.firstPrompt = undefined
}

function readClaudeTitleLine(state: ClaudeTitleState, line: string): void {
  const record = jsonRecord(line)
  const type = stringField(record, "type")
  if (!type) return

  if (type === "custom-title") state.customTitle = firstTitle(stringField(record, "customTitle"), stringField(record, "title"))
  else if (type === "ai-title") state.aiTitle = firstTitle(stringField(record, "aiTitle"), stringField(record, "title"))
  else if (type === "last-prompt") state.lastPrompt = firstTitle(stringField(record, "lastPrompt"), stringField(record, "prompt"))
  else if (type === "summary") state.summary = stringField(record, "summary")
  else if (type === "user" && !state.firstPrompt && record?.["isMeta"] !== true) {
    state.firstPrompt = messageText(record?.["message"])
  }
}

function claudeIndex(
  directory: string,
  cache: Map<string, Map<string, ClaudeIndexTitle>>,
): Map<string, ClaudeIndexTitle> {
  const held = cache.get(directory)
  if (held) return held

  const entries = new Map<string, ClaudeIndexTitle>()
  const path = join(directory, "sessions-index.json")
  try {
    const document = JSON.parse(readFileSync(path, "utf8")) as unknown
    const list = recordOf(document)?.["entries"]
    if (Array.isArray(list)) {
      for (const item of list) {
        const record = recordOf(item)
        const id = stringField(record, "sessionId")
        if (!id) continue
        entries.set(id, {
          customTitle: firstTitle(stringField(record, "customTitle"), stringField(record, "name")),
          aiTitle: stringField(record, "aiTitle"),
          summary: stringField(record, "summary"),
          firstPrompt: stringField(record, "firstPrompt"),
        })
      }
    }
  } catch {
    // Some Claude sessions have no index. Their transcript remains canonical.
  }
  cache.set(directory, entries)
  return entries
}

function messageText(value: unknown): string | undefined {
  const message = recordOf(value)
  const content = message?.["content"]
  if (typeof content === "string") return cleanTitle(content)
  if (!Array.isArray(content)) return undefined
  return cleanTitle(
    content
      .map((part) => {
        const record = recordOf(part)
        return record?.["type"] === "text" && typeof record["text"] === "string" ? record["text"] : ""
      })
      .filter(Boolean)
      .join("\n"),
  )
}

function jsonRecord(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return undefined
  try {
    return recordOf(JSON.parse(trimmed))
  } catch {
    return undefined
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  return typeof record?.[key] === "string" ? cleanTitle(record[key] as string) : undefined
}

function firstTitle(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const title = cleanTitle(value)
    if (title) return title
  }
  return undefined
}

function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const title = value.trim()
  return title.length > 0 ? title : undefined
}

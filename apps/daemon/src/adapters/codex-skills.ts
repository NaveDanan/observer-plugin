import { homedir } from "node:os"
import { resolve } from "node:path"
import { spawnCodexAppServer } from "./codex.js"
import type { CodexSpawn, CodexSpawnResult } from "./codex.js"

const INITIALIZE_ID = 1
const SKILLS_LIST_ID = 2
const DEFAULT_BINARY = "codex"
const DEFAULT_TIMEOUT_MS = 4_000

export interface CodexAvailableSkill {
  name: string
  description: string
  path: string
  /** Codex currently reports user, repo, system, or admin. Kept open for newer hosts. */
  scope: string
}

export interface CodexSkillInventory {
  skills: CodexAvailableSkill[]
  warnings: string[]
}

export interface CodexSkillDiscoveryOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  homeDir?: () => string
  binaryPath?: string
  timeoutMs?: number
  spawn?: CodexSpawn
}

/**
 * Asks Codex for the enabled skills visible from one project directory.
 *
 * `skills/list` is the authority here instead of a hand-maintained directory
 * list. Codex merges project and global roots, plugin skills, admin skills,
 * enablement settings, and name collisions before it answers. Observer would
 * get a subtly different inventory if it tried to reproduce that merge.
 *
 * The probe is fail-open. Employee definitions are still generated when
 * Codex is absent, too old, or slow; the returned warning explains why their
 * Default pack is empty for that sync.
 */
export function fetchCodexSkills(options: CodexSkillDiscoveryOptions = {}): CodexSkillInventory {
  const cwd = resolve(options.cwd ?? process.cwd())
  const env = options.env ?? process.env
  const home = configuredHome(env, options.homeDir ?? homedir)
  const binary = options.binaryPath?.trim() || DEFAULT_BINARY
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const spawn = options.spawn ?? spawnCodexAppServer
  const input = [
    JSON.stringify({
      jsonrpc: "2.0",
      id: INITIALIZE_ID,
      method: "initialize",
      params: { clientInfo: { name: "observer", title: "Observer", version: "0.9.14" } },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: SKILLS_LIST_ID,
      method: "skills/list",
      params: { cwds: [cwd], forceReload: true },
    }),
    "",
  ].join("\n")

  let result: CodexSpawnResult
  try {
    result = spawn(binary, ["app-server"], {
      input,
      env: { ...env, CODEX_HOME: home },
      timeoutMs,
    })
  } catch (error) {
    return empty(`Codex skill discovery could not start: ${describeError(error)}.`)
  }

  const response = findResponse(result.stdout)
  if (!response) {
    if (result.failure) return empty(`Codex skill discovery could not start: ${result.failure}.`)
    if (result.timedOut) return empty(`Codex did not list skills within ${timeoutMs} ms.`)
    if (result.status !== 0) return empty(`Codex exited before listing skills.`)
    return empty(`Codex returned no readable answer to "skills/list".`)
  }
  if (isRecord(response["error"])) {
    const message = response["error"]["message"]
    return empty(`Codex refused "skills/list"${typeof message === "string" && message ? `: ${message}` : "."}`)
  }

  const payload = response["result"]
  if (!isRecord(payload) || !Array.isArray(payload["data"])) {
    return empty(`Codex returned an unreadable answer to "skills/list".`)
  }
  const entries = payload["data"].filter(isRecord)
  const entry = entries.find((candidate) => samePath(candidate["cwd"], cwd)) ?? entries[0]
  if (!entry) return { skills: [], warnings: [] }

  const warnings = readErrors(entry["errors"])
  const skills = readSkills(entry["skills"])
  return { skills, warnings }
}

function configuredHome(env: NodeJS.ProcessEnv, readHome: () => string): string {
  const configured = env["CODEX_HOME"]
  return typeof configured === "string" && configured.trim() ? configured.trim() : resolve(readHome(), ".codex")
}

function findResponse(stdout: string): Record<string, unknown> | undefined {
  if (typeof stdout !== "string") return undefined
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed) && parsed["id"] === SKILLS_LIST_ID) return parsed
    } catch {
      // A CLI banner or progress line is not the JSON-RPC response.
    }
  }
  return undefined
}

function readSkills(raw: unknown): CodexAvailableSkill[] {
  if (!Array.isArray(raw)) return []
  const found = new Map<string, CodexAvailableSkill>()
  for (const value of raw) {
    if (!isRecord(value) || value["enabled"] !== true) continue
    const name = text(value["name"])
    const path = text(value["path"])
    if (!name || !path) continue
    const key = process.platform === "win32" ? path.toLowerCase() : path
    if (found.has(key)) continue
    found.set(key, {
      name,
      description: text(value["description"]) ?? "",
      path,
      scope: text(value["scope"]) ?? "unknown",
    })
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path))
}

function readErrors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((value) => {
    if (!isRecord(value)) return []
    const message = text(value["message"])
    const path = text(value["path"])
    if (!message) return []
    return [path ? `Codex could not load skill ${path}: ${message}` : `Codex could not load a skill: ${message}`]
  })
}

function samePath(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false
  const left = resolve(value)
  return process.platform === "win32" ? left.toLowerCase() === expected.toLowerCase() : left === expected
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function empty(warning: string): CodexSkillInventory {
  return { skills: [], warnings: [warning] }
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

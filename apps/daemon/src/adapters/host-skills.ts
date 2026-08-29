import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fetchCodexSkills } from "./codex-skills.js"
import type { CodexSkillDiscoveryOptions, CodexSkillInventory } from "./codex-skills.js"

export const SKILL_HOSTS = ["opencode", "codex", "claude", "copilot"] as const
export type SkillHost = (typeof SKILL_HOSTS)[number]

export interface HostSkillLocation {
  host: SkillHost
  path?: string
  scope: string
  source: string
}

export interface HostAvailableSkill {
  name: string
  description: string
  /** First readable SKILL.md path, retained for the existing TUI detail row. */
  path?: string
  scope: string
  hosts: SkillHost[]
  locations: HostSkillLocation[]
}

export interface HostSkillSummary {
  host: SkillHost
  count: number
  discovery: "native" | "filesystem" | "unavailable"
  source: string
}

export interface HostSkillInventory {
  skills: HostAvailableSkill[]
  summaries: HostSkillSummary[]
  warnings: string[]
}

export interface SkillCommandResult {
  stdout: string
  status: number | null
  timedOut?: boolean
  failure?: string
}

export type SkillCommandRunner = (
  binary: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => SkillCommandResult

export interface HostSkillDiscoveryOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  homeDir?: () => string
  timeoutMs?: number
  run?: SkillCommandRunner
  codex?: Omit<CodexSkillDiscoveryOptions, "cwd" | "env" | "homeDir" | "timeoutMs">
}

interface DiscoveredHostSkills {
  host: SkillHost
  skills: HostSkillLocationRecord[]
  warnings: string[]
  discovery: HostSkillSummary["discovery"]
  source: string
}

interface HostSkillLocationRecord extends HostSkillLocation {
  name: string
  description: string
}

const DEFAULT_TIMEOUT_MS = 2_000
const MAX_STDOUT = 16 * 1024 * 1024

/**
 * Reads the inventory each supported host exposes for one project.
 *
 * Codex, OpenCode, and Copilot have native listing commands, which remain the
 * authority for collision, plugin, permission, and remote-source rules. Claude
 * Code has no non-interactive skill-list command, so its documented user,
 * project, and installed-plugin roots are read from disk. OpenCode and Copilot
 * fall back to their documented roots when an older or unavailable CLI cannot
 * answer, and say so in the warning list.
 */
export function fetchHostSkills(options: HostSkillDiscoveryOptions = {}): HostSkillInventory {
  const cwd = resolve(options.cwd ?? process.cwd())
  const env = options.env ?? process.env
  const readHome = options.homeDir ?? homedir
  const home = resolve(readHome())
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const run = options.run ?? runSkillCommand

  const discovered = [
    discoverOpenCode(cwd, home, env, timeoutMs, run),
    discoverCodex(cwd, home, env, readHome, timeoutMs, options.codex),
    discoverClaude(cwd, home),
    discoverCopilot(cwd, home, env, timeoutMs, run),
  ]

  return merge(discovered)
}

/** Codex discovery with the same filesystem safety net the cross-host TUI uses. */
export function fetchCodexSkillsWithFallback(options: CodexSkillDiscoveryOptions = {}): CodexSkillInventory {
  const cwd = resolve(options.cwd ?? process.cwd())
  const env = options.env ?? process.env
  const readHome = options.homeDir ?? homedir
  const home = resolve(readHome())
  const inventory = fetchCodexSkills({ ...options, cwd, env, homeDir: readHome })
  if (inventory.skills.length > 0 || inventory.warnings.length === 0) return inventory
  const fallback = scanSkillRoots("codex", codexRoots(cwd, home), cwd, home)
  return {
    skills: fallback.flatMap((skill) => skill.path ? [{
      name: skill.name,
      description: skill.description,
      path: skill.path,
      scope: skill.scope,
    }] : []),
    warnings: inventory.warnings.map((warning) => `${warning} Used documented filesystem roots as a fallback.`),
  }
}

function discoverCodex(
  cwd: string,
  home: string,
  env: NodeJS.ProcessEnv,
  readHome: () => string,
  timeoutMs: number,
  options: HostSkillDiscoveryOptions["codex"],
): DiscoveredHostSkills {
  const inventory = fetchCodexSkillsWithFallback({ ...options, cwd, env, homeDir: readHome, timeoutMs })
  const fallback = inventory.warnings.some((warning) => warning.includes("filesystem roots as a fallback"))
  return {
    host: "codex",
    skills: inventory.skills.map((skill) => ({
      ...skill,
      host: "codex",
      source: fallback ? "Codex skill roots" : "codex app-server skills/list",
    })),
    warnings: inventory.warnings.map((warning) => `Codex: ${warning}`),
    discovery: fallback ? (inventory.skills.length > 0 ? "filesystem" : "unavailable") : "native",
    source: fallback ? "Codex skill roots" : "codex app-server skills/list",
  }
}

function discoverOpenCode(
  cwd: string,
  home: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  run: SkillCommandRunner,
): DiscoveredHostSkills {
  const result = safeRun(run, env["OPENCODE_BINARY"]?.trim() || "opencode", ["debug", "skill"], cwd, env, timeoutMs)
  const native = result === undefined ? undefined : readOpenCode(result.stdout, cwd, home)
  if (native !== undefined) {
    return {
      host: "opencode",
      skills: native,
      warnings: [],
      discovery: "native",
      source: "opencode debug skill",
    }
  }

  const fallback = scanSkillRoots("opencode", openCodeRoots(cwd, home), cwd, home)
  return {
    host: "opencode",
    skills: fallback,
    warnings: [`OpenCode: ${commandFailure(result, "opencode debug skill")} Used documented filesystem roots as a fallback.`],
    discovery: fallback.length > 0 ? "filesystem" : "unavailable",
    source: "OpenCode skill roots",
  }
}

function discoverCopilot(
  cwd: string,
  home: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  run: SkillCommandRunner,
): DiscoveredHostSkills {
  const result = safeRun(run, env["COPILOT_BINARY"]?.trim() || "copilot", ["plugins", "list", "--kind", "skill", "--json"], cwd, env, timeoutMs)
  const native = result === undefined ? undefined : readCopilot(result.stdout)
  if (native !== undefined) {
    const fileSkills = scanSkillRoots("copilot", copilotRoots(cwd, home, env), cwd, home)
    const paths = new Map(fileSkills.map((skill) => [skill.name.toLowerCase(), skill]))
    return {
      host: "copilot",
      skills: native.map((skill) => {
        const file = paths.get(skill.name.toLowerCase())
        return file === undefined ? skill : { ...skill, path: file.path, scope: file.scope }
      }),
      warnings: [],
      discovery: "native",
      source: "copilot plugins list --kind skill --json",
    }
  }

  const fallback = scanSkillRoots("copilot", copilotRoots(cwd, home, env), cwd, home)
  return {
    host: "copilot",
    skills: fallback,
    warnings: [`Copilot: ${commandFailure(result, "copilot plugins list")} Used documented filesystem roots as a fallback.`],
    discovery: fallback.length > 0 ? "filesystem" : "unavailable",
    source: "Copilot skill roots",
  }
}

function discoverClaude(cwd: string, home: string): DiscoveredHostSkills {
  const roots = claudeRoots(cwd, home)
  const skills = scanSkillRoots("claude", roots, cwd, home)
  const overrides = claudeSkillOverrides(cwd, home)
  const visible = skills.filter((skill) => {
    const state = overrides.get(skill.name)
    return state !== "off" && state !== "user-invocable-only"
  })
  return {
    host: "claude",
    skills: visible,
    warnings: [],
    discovery: "filesystem",
    source: "Claude Code skill roots and installed plugin registry",
  }
}

function merge(inventories: DiscoveredHostSkills[]): HostSkillInventory {
  const merged = new Map<string, HostAvailableSkill>()
  const summaries: HostSkillSummary[] = []
  const warnings: string[] = []

  for (const inventory of inventories) {
    summaries.push({
      host: inventory.host,
      count: inventory.skills.length,
      discovery: inventory.discovery,
      source: inventory.source,
    })
    warnings.push(...inventory.warnings)
    for (const skill of inventory.skills) {
      const key = skill.name.toLowerCase()
      const before = merged.get(key)
      if (before === undefined) {
        merged.set(key, {
          name: skill.name,
          description: skill.description,
          ...(skill.path === undefined ? {} : { path: skill.path }),
          scope: skill.scope,
          hosts: [skill.host],
          locations: [location(skill)],
        })
        continue
      }
      if (!before.hosts.includes(skill.host)) before.hosts.push(skill.host)
      before.locations.push(location(skill))
      if (!before.path && skill.path) before.path = skill.path
      if (!before.description && skill.description) before.description = skill.description
      if (scopeRank(skill.scope) < scopeRank(before.scope)) before.scope = skill.scope
    }
  }

  const hostOrder = new Map(SKILL_HOSTS.map((host, index) => [host, index]))
  const skills = [...merged.values()]
  for (const skill of skills) {
    skill.hosts.sort((left, right) => hostOrder.get(left)! - hostOrder.get(right)!)
    skill.locations.sort((left, right) => hostOrder.get(left.host)! - hostOrder.get(right.host)!)
  }
  skills.sort((left, right) => left.name.localeCompare(right.name))
  return { skills, summaries, warnings }
}

function location(skill: HostSkillLocationRecord): HostSkillLocation {
  return {
    host: skill.host,
    ...(skill.path === undefined ? {} : { path: skill.path }),
    scope: skill.scope,
    source: skill.source,
  }
}

function readOpenCode(stdout: string, cwd: string, home: string): HostSkillLocationRecord[] | undefined {
  const parsed = parseJson(stdout)
  if (!Array.isArray(parsed)) return undefined
  return parsed.flatMap((value): HostSkillLocationRecord[] => {
    if (!isRecord(value)) return []
    const name = text(value["name"])
    const description = text(value["description"])
    const rawLocation = text(value["location"])
    if (!name || !description || !rawLocation) return []
    const path = rawLocation === "<built-in>" ? undefined : rawLocation
    return [{
      host: "opencode",
      name,
      description,
      ...(path === undefined ? {} : { path }),
      scope: skillScope(path, cwd, home, rawLocation === "<built-in>" ? "builtin" : "unknown"),
      source: rawLocation === "<built-in>" ? "built-in" : "opencode debug skill",
    }]
  })
}

function readCopilot(stdout: string): HostSkillLocationRecord[] | undefined {
  const parsed = parseJson(stdout)
  if (!isRecord(parsed) || !Array.isArray(parsed["plugins"])) return undefined
  return parsed["plugins"].flatMap((value): HostSkillLocationRecord[] => {
    if (!isRecord(value) || value["kind"] !== "skill" || value["enabled"] !== true) return []
    const name = text(value["name"])
    const description = text(value["description"])
    if (!name || !description) return []
    return [{
      host: "copilot",
      name,
      description,
      scope: text(value["scope"]) ?? "unknown",
      source: text(value["source"]) ?? "copilot plugins list",
    }]
  })
}

function scanSkillRoots(
  host: SkillHost,
  roots: string[],
  cwd: string,
  home: string,
): HostSkillLocationRecord[] {
  const found = new Map<string, HostSkillLocationRecord>()
  for (const root of roots) {
    for (const path of skillFiles(root)) {
      const parsed = readSkill(path)
      if (!parsed) continue
      const key = parsed.name.toLowerCase()
      if (found.has(key)) continue
      found.set(key, {
        host,
        name: parsed.name,
        description: parsed.description,
        path,
        scope: skillScope(path, cwd, home, "unknown"),
        source: root,
      })
    }
  }
  return [...found.values()]
}

function skillFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  const stack = [root]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const directory = stack.pop()!
    let canonical: string
    try {
      canonical = realpathSync(directory)
    } catch {
      continue
    }
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical
    if (visited.has(key)) continue
    visited.add(key)
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path))) stack.push(path)
      else if (entry.isFile() && entry.name === "SKILL.md") found.push(path)
    }
  }
  return found.sort()
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readSkill(path: string): { name: string; description: string } | undefined {
  let source: string
  try {
    source = readFileSync(path, "utf8").slice(0, 128 * 1024)
  } catch {
    return undefined
  }
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
  if (!match) return undefined
  const frontmatter = match[1] ?? ""
  const name = yamlText(frontmatter, "name") ?? basename(dirname(path))
  const description = yamlText(frontmatter, "description")
  if (!name.trim() || !description?.trim()) return undefined
  return { name: name.trim(), description: description.trim() }
}

function yamlText(frontmatter: string, field: string): string | undefined {
  const lines = frontmatter.split(/\r?\n/)
  const pattern = new RegExp(`^${field}:\\s*(.*)$`)
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(pattern)
    if (!match) continue
    const raw = (match[1] ?? "").trim()
    if (raw === ">" || raw === "|") {
      const block: string[] = []
      for (let at = index + 1; at < lines.length && /^\s+/.test(lines[at]!); at += 1) block.push(lines[at]!.trim())
      return raw === ">" ? block.join(" ") : block.join("\n")
    }
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        return JSON.parse(raw) as string
      } catch {
        return raw.slice(1, -1)
      }
    }
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'")
    return raw
  }
  return undefined
}

function openCodeRoots(cwd: string, home: string): string[] {
  const project = projectDirectories(cwd)
  return [
    ...project.flatMap((directory) => [
      join(directory, ".opencode", "skills"),
      join(directory, ".opencode", "skill"),
      join(directory, ".claude", "skills"),
      join(directory, ".agents", "skills"),
    ]),
    join(home, ".config", "opencode", "skills"),
    join(home, ".config", "opencode", "skill"),
    join(home, ".claude", "skills"),
    join(home, ".agents", "skills"),
  ]
}

function codexRoots(cwd: string, home: string): string[] {
  const project = projectDirectories(cwd)
  return [
    ...project.flatMap((directory) => [
      join(directory, ".agents", "skills"),
      join(directory, ".codex", "skills"),
    ]),
    join(home, ".agents", "skills"),
    join(home, ".codex", "skills"),
  ]
}

function copilotRoots(cwd: string, home: string, env: NodeJS.ProcessEnv): string[] {
  const project = projectDirectories(cwd)
  const extra = (env["COPILOT_SKILLS_DIRS"] ?? "")
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => resolve(cwd, path))
  return [
    ...project.flatMap((directory) => [
      join(directory, ".github", "skills"),
      join(directory, ".agents", "skills"),
      join(directory, ".claude", "skills"),
    ]),
    join(home, ".copilot", "skills"),
    join(home, ".agents", "skills"),
    ...extra,
  ]
}

function claudeRoots(cwd: string, home: string): string[] {
  return [
    ...projectDirectories(cwd).map((directory) => join(directory, ".claude", "skills")),
    join(home, ".claude", "skills"),
    ...claudePluginRoots(home),
  ]
}

function claudePluginRoots(home: string): string[] {
  const registry = join(home, ".claude", "plugins", "installed_plugins.json")
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(registry, "utf8")) as unknown
  } catch {
    return []
  }
  const roots: string[] = []
  visit(parsed, (record) => {
    const installPath = text(record["installPath"])
    if (installPath && isAbsolute(installPath)) roots.push(join(installPath, "skills"))
  })
  return roots
}

function claudeSkillOverrides(cwd: string, home: string): Map<string, string> {
  const result = new Map<string, string>()
  const files = [
    join(home, ".claude", "settings.json"),
    ...projectDirectories(cwd).reverse().flatMap((directory) => [
      join(directory, ".claude", "settings.json"),
      join(directory, ".claude", "settings.local.json"),
    ]),
  ]
  for (const path of files) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
      if (!isRecord(parsed) || !isRecord(parsed["skillOverrides"])) continue
      for (const [name, value] of Object.entries(parsed["skillOverrides"])) {
        if (typeof value === "string") result.set(name, value)
      }
    } catch {
      // A malformed host setting remains the host's warning to report.
    }
  }
  return result
}

function projectDirectories(cwd: string): string[] {
  const found: string[] = []
  let directory = cwd
  while (true) {
    found.push(directory)
    if (existsSync(join(directory, ".git"))) break
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return found
}

function skillScope(path: string | undefined, cwd: string, home: string, fallback: string): string {
  if (!path) return fallback
  if (inside(cwd, path)) return "repo"
  if (inside(home, path)) return "user"
  return fallback
}

function inside(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path))
  return value === "" || (!value.startsWith("..") && !isAbsolute(value))
}

function scopeRank(scope: string): number {
  if (scope === "repo" || scope === "repository" || scope === "working-directory") return 0
  if (scope === "user") return 1
  if (scope === "plugin") return 2
  if (scope === "builtin" || scope === "system") return 3
  return 4
}

function safeRun(
  run: SkillCommandRunner,
  binary: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): SkillCommandResult | undefined {
  try {
    return run(binary, args, { cwd, env, timeoutMs })
  } catch (error) {
    return { stdout: "", status: null, failure: describeError(error) }
  }
}

function commandFailure(result: SkillCommandResult | undefined, command: string): string {
  if (result?.failure) return `${command} could not start (${result.failure}).`
  if (result?.timedOut) return `${command} did not answer within the discovery budget.`
  if (result && result.status !== 0) return `${command} exited before returning a readable inventory.`
  return `${command} returned no readable inventory.`
}

export function runSkillCommand(
  binary: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): SkillCommandResult {
  const values = [binary, ...args]
  if (process.platform === "win32" && values.some((value) => /[\r\n"%!&|<>^]/.test(value))) {
    return { stdout: "", status: null, failure: "unsafe Windows command value" }
  }
  const command = process.platform === "win32"
    ? (process.env["ComSpec"] ?? process.env["COMSPEC"] ?? "cmd.exe")
    : binary
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", `"${values.map((value) => `"${value}"`).join(" ")}"`]
    : [...args]
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: options.timeoutMs,
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
    maxBuffer: MAX_STDOUT,
  })
  const output: SkillCommandResult = {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    status: result.status,
  }
  const error = result.error as (Error & { code?: string }) | undefined
  if (error?.code === "ETIMEDOUT" || result.signal) output.timedOut = true
  else if (error) output.failure = error.code ?? error.message
  return output
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source)
  } catch {
    return undefined
  }
}

function visit(value: unknown, callback: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const entry of value) visit(entry, callback)
    return
  }
  if (!isRecord(value)) return
  callback(value)
  for (const entry of Object.values(value)) visit(entry, callback)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

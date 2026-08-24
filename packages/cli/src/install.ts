import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { loadConfig } from "@observer-ai/daemon"
import type { HostId } from "@observer-ai/protocol"
import {
  emitterPath,
  hookPowershellCommand,
  hookShellCommand,
  homeDir,
  nodePath,
  opencodeAgentDir,
  opencodeAgentSource,
  opencodeConfigBase,
  opencodePluginSource,
  recordInstallPaths,
} from "./paths.js"
import { removeSeatAgents, syncSeatAgents } from "./seat-agents.js"

export interface InstallResult {
  host: HostId
  action: "installed" | "updated" | "removed" | "unchanged" | "missing"
  path: string
  notes: string[]
}

/** Hook events Observer subscribes to, per host. */
export const HOST_EVENTS: Record<Exclude<HostId, "opencode">, string[]> = {
  claude: [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "UserPromptExpansion",
    "MessageDisplay",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "StopFailure",
    "InstructionsLoaded",
  ],
  codex: [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
  ],
  copilot: [
    "sessionStart",
    "sessionEnd",
    "userPromptSubmitted",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "agentStop",
    "subagentStart",
    "subagentStop",
    "errorOccurred",
  ],
}

const HOOK_TIMEOUT_SECONDS = 5
const CODEX_DESCRIPTION = "Observer agent telemetry"
const BACKUP_SUFFIX = ".observer-backup"

// --------------------------------------------------------------- host paths

export function claudeSettingsPath(): string {
  return join(homeDir(), ".claude", "settings.json")
}

export function codexHooksPath(): string {
  const home = process.env["CODEX_HOME"]
  return join(home && home.length > 0 ? home : join(homeDir(), ".codex"), "hooks.json")
}

export function copilotHooksPath(): string {
  const home = process.env["COPILOT_HOME"]
  return join(home && home.length > 0 ? home : join(homeDir(), ".copilot"), "hooks", "observer.json")
}

function opencodeConfigRoot(): string {
  return join(opencodeConfigBase(), "opencode")
}

export function opencodePluginPath(): string {
  return join(opencodeConfigRoot(), "plugins", "observer.js")
}

/** The agent definition that puts `@observer` in OpenCode's @ menu. */
export function opencodeAgentPath(): string {
  return join(opencodeAgentDir(), "observer.md")
}

export function hostConfigPath(host: HostId): string {
  switch (host) {
    case "claude":
      return claudeSettingsPath()
    case "codex":
      return codexHooksPath()
    case "copilot":
      return copilotHooksPath()
    case "opencode":
      return opencodePluginPath()
  }
}

// ------------------------------------------------------------------ install

export function install(host: HostId): InstallResult {
  switch (host) {
    case "claude":
      return installClaude()
    case "codex":
      return installCodex()
    case "copilot":
      return installCopilot()
    case "opencode":
      return installOpencode()
  }
}

export function uninstall(host: HostId): InstallResult {
  switch (host) {
    case "claude":
      return removeFromJsonHooks("claude", claudeSettingsPath())
    case "codex":
      return removeFromJsonHooks("codex", codexHooksPath())
    case "copilot":
      return removeFile("copilot", copilotHooksPath())
    case "opencode":
      return removeOpencode()
  }
}

export function isInstalled(host: HostId): boolean {
  const path = hostConfigPath(host)
  if (!existsSync(path)) return false
  if (host === "opencode") return true
  try {
    const text = readFileSync(path, "utf8")
    return text.includes("emit.js") || text.includes(`"Observer"`)
  } catch {
    return false
  }
}

function installClaude(): InstallResult {
  const path = claudeSettingsPath()
  const settings = readJson(path) ?? {}
  const hooks = isRecord(settings["hooks"]) ? (settings["hooks"] as Record<string, unknown>) : {}
  const existed = isInstalled("claude")

  for (const event of HOST_EVENTS.claude) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    const kept = groups.filter((group) => !isObserverEntry(group))
    kept.push({
      hooks: [
        {
          type: "command",
          // Exec form: no shell, so paths with spaces need no quoting.
          command: nodePath(),
          args: [emitterPath(), "--host", "claude", "--event", event],
          timeout: HOOK_TIMEOUT_SECONDS,
          statusMessage: "Observer",
        },
      ],
    })
    hooks[event] = kept
  }

  settings["hooks"] = hooks
  writeJson(path, settings)
  return {
    host: "claude",
    action: existed ? "updated" : "installed",
    path,
    notes: ["Restart Claude Code, or start a new session, for the hooks to load."],
  }
}

function installCodex(): InstallResult {
  const path = codexHooksPath()
  const document = readJson(path) ?? {}
  const hooks = isRecord(document["hooks"]) ? (document["hooks"] as Record<string, unknown>) : {}
  const existed = isInstalled("codex")

  for (const event of HOST_EVENTS.codex) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    const kept = groups.filter((group) => !isObserverEntry(group))
    kept.push({
      hooks: [
        {
          type: "command",
          command: hookShellCommand("codex", event),
          timeout: HOOK_TIMEOUT_SECONDS,
          statusMessage: "Observer",
        },
      ],
    })
    hooks[event] = kept
  }

  document["description"] = CODEX_DESCRIPTION
  document["hooks"] = hooks
  writeJson(path, document)
  return {
    host: "codex",
    action: existed ? "updated" : "installed",
    path,
    notes: [
      "Codex requires you to trust new hooks: run `/hooks` inside Codex and approve the Observer entries.",
      "Hooks are enabled by default; if disabled, set `[features] hooks = true` in ~/.codex/config.toml.",
    ],
  }
}

function installCopilot(): InstallResult {
  const path = copilotHooksPath()
  const existed = existsSync(path)
  const hooks: Record<string, unknown> = {}
  for (const event of HOST_EVENTS.copilot) {
    hooks[event] = [
      {
        type: "command",
        bash: hookShellCommand("copilot", event),
        powershell: hookPowershellCommand("copilot", event),
        timeoutSec: HOOK_TIMEOUT_SECONDS,
      },
    ]
  }
  writeJson(path, { version: 1, hooks })
  return {
    host: "copilot",
    action: existed ? "updated" : "installed",
    path,
    notes: ["Copilot CLI loads hook files at startup; restart any running session."],
  }
}

function installOpencode(): InstallResult {
  const path = opencodePluginPath()
  const source = opencodePluginSource()
  if (!existsSync(source)) {
    return { host: "opencode", action: "missing", path, notes: [`Plugin source not found at ${source}`] }
  }
  const existed = existsSync(path)
  mkdirSync(dirname(path), { recursive: true })
  copyFileSync(source, path)
  // The copied plugin cannot find the daemon by probing its own neighbourhood,
  // so record where the build lives for its autostart to read.
  recordInstallPaths()

  // The agent definition is what makes @observer appear in OpenCode's @ menu;
  // the plugin alone cannot add entries there.
  const agentSource = opencodeAgentSource()
  let agentNote = ""
  if (existsSync(agentSource)) {
    const agentPath = opencodeAgentPath()
    mkdirSync(dirname(agentPath), { recursive: true })
    copyFileSync(agentSource, agentPath)
    agentNote = ` @observer mention installed to ${agentPath}.`
  }

  return {
    host: "opencode",
    action: existed ? "updated" : "installed",
    path,
    notes: [`Restart OpenCode; plugins and agents load at startup.${agentNote}`, ...syncSeatAgentsQuietly()],
  }
}

/**
 * Reconciles the generated seat definitions as part of installing.
 *
 * Re-running the installer is the documented cure for a config that was edited
 * without one, so this is where drift gets corrected. It is best-effort: a
 * seats section Observer cannot read must not stop the plugin being installed,
 * because the plugin is the part that observes and the seats are the part that
 * merely steers.
 */
function syncSeatAgentsQuietly(): string[] {
  try {
    return syncSeatAgents(loadConfig().seats).notes
  } catch {
    return []
  }
}

function removeOpencode(): InstallResult {
  const results = [
    removeFile("opencode", opencodePluginPath()),
    removeFile("opencode", opencodeAgentPath()),
  ]
  // Generated seat definitions name a model the user chose through Observer,
  // so leaving them behind would keep steering delegations after Observer is
  // gone. Only files carrying Observer's marker are touched.
  const seatAgents = removeSeatAgents()
  const removedFiles = results.some((result) => result.action === "removed")
  const notes: string[] = []
  if (removedFiles) notes.push("Removed the Observer plugin and agent definition.")
  if (seatAgents.length > 0) {
    notes.push(`Removed ${seatAgents.length} generated seat agent definition${seatAgents.length === 1 ? "" : "s"}.`)
  }
  return {
    host: "opencode",
    action: removedFiles || seatAgents.length > 0 ? "removed" : "unchanged",
    path: opencodePluginPath(),
    notes,
  }
}

function removeFromJsonHooks(host: HostId, path: string): InstallResult {
  if (!existsSync(path)) return { host, action: "unchanged", path, notes: ["Nothing to remove."] }
  const document = readJson(path)
  if (!document || !isRecord(document["hooks"])) {
    return { host, action: "unchanged", path, notes: ["No hooks section found."] }
  }
  const hooks = document["hooks"] as Record<string, unknown>
  let removed = 0
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    const kept = groups.filter((group) => !isObserverEntry(group))
    removed += groups.length - kept.length
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  if (Object.keys(hooks).length === 0) delete document["hooks"]
  // Drop the marker Observer added, but only if it is still ours.
  if (document["description"] === CODEX_DESCRIPTION) delete document["description"]

  if (Object.keys(document).length === 0) {
    // Nothing of the user's remains, so the file was Observer's to begin with.
    rmSync(path, { force: true })
    rmSync(`${path}${BACKUP_SUFFIX}`, { force: true })
    return { host, action: "removed", path, notes: ["Removed the hook file Observer created."] }
  }

  writeJson(path, document)
  if (removed > 0) rmSync(`${path}${BACKUP_SUFFIX}`, { force: true })
  return {
    host,
    action: removed > 0 ? "removed" : "unchanged",
    path,
    notes: removed > 0 ? [`Removed ${removed} Observer hook entries.`] : ["No Observer hooks were present."],
  }
}

function removeFile(host: HostId, path: string): InstallResult {
  if (!existsSync(path)) return { host, action: "unchanged", path, notes: ["Nothing to remove."] }
  rmSync(path)
  rmSync(`${path}${BACKUP_SUFFIX}`, { force: true })
  return { host, action: "removed", path, notes: [] }
}

// ------------------------------------------------------------------ helpers

/**
 * Identifies entries this tool created, so uninstall never touches user hooks.
 * Matches the `Observer` status marker, or an emitter invocation as a fallback
 * for entries written by older versions.
 */
function isObserverEntry(value: unknown): boolean {
  try {
    const text = JSON.stringify(value) ?? ""
    return text.includes(`"Observer"`) || (text.includes("emit.js") && text.includes("--host"))
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    const raw = readFileSync(path, "utf8")
    // Tolerate the JSONC some hosts allow in their settings files.
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "")
    const parsed = JSON.parse(stripped) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) {
    // Keep a single rollback copy: these are the user's own config files.
    try {
      copyFileSync(path, `${path}.observer-backup`)
    } catch {
      // A missing backup must not block installation.
    }
  }
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

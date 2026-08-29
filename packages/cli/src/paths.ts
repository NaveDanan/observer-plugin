import { createRequire } from "node:module"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, win32 } from "node:path"
import { fileURLToPath } from "node:url"
import { dataDir } from "@observer-ai/storage"

const require = createRequire(import.meta.url)

/** Directory of the running CLI bundle. */
function here(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * Returns the first candidate that exists, or the first candidate as a
 * fallback so error messages name a concrete path.
 *
 * Observer runs from two layouts: the monorepo during development, and a flat
 * published package after `npm i -g`. Every internal path is probed rather
 * than assumed so a release cannot break on layout differences alone.
 */
function firstExisting(candidates: string[]): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0] as string
}

/** Absolute path to the hook emitter that host hooks execute. */
export function emitterPath(): string {
  const candidates = [
    resolve(here(), "./emit.js"), // published package: dist/emit.js
    resolve(here(), "../../hook-emitter/dist/emit.js"), // monorepo
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  try {
    return require.resolve("@observer-ai/hook-emitter/dist/emit.js")
  } catch {
    return candidates[0] as string
  }
}

/** Absolute path to the synchronous Copilot seat controller. */
export function copilotControlPath(): string {
  const candidates = [
    resolve(here(), "./copilot-control.js"), // published package
    resolve(here(), "../../hook-emitter/dist/copilot-control.js"), // monorepo
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  try {
    return require.resolve("@observer-ai/hook-emitter/dist/copilot-control.js")
  } catch {
    return candidates[0] as string
  }
}

/** Absolute path to the daemon entry point. */
export function daemonPath(): string {
  const candidates = [
    resolve(here(), "./daemon.js"), // published package
    resolve(here(), "../../../apps/daemon/dist/main.js"), // monorepo
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  try {
    return require.resolve("@observer-ai/daemon/dist/main.js")
  } catch {
    return candidates[0] as string
  }
}

/** Absolute path to the OpenCode plugin shipped with Observer. */
export function opencodePluginSource(): string {
  return firstExisting([
    resolve(here(), "../integrations/opencode/observer-plugin.js"), // published package
    resolve(here(), "../../../integrations/opencode/observer-plugin.js"), // monorepo
  ])
}

/**
 * Absolute path to the OpenCode agent definition shipped with Observer.
 *
 * This is what puts `@observer` in OpenCode's @ menu: that menu lists
 * registered agents, not plugin tokens.
 */
export function opencodeAgentSource(): string {
  return firstExisting([
    resolve(here(), "../integrations/opencode/observer-agent.md"), // published package
    resolve(here(), "../../../integrations/opencode/observer-agent.md"), // monorepo
  ])
}

/** The Node binary the hooks should run. */
export function nodePath(): string {
  return process.execPath
}

/**
 * The pointer file that tells the installed OpenCode plugin where the daemon
 * lives.
 *
 * The plugin is copied verbatim into OpenCode's config directory, so unlike the
 * hook emitter it cannot find the daemon by probing its own neighbourhood. The
 * installer writes this record and the plugin reads it back when the daemon is
 * not listening.
 */
export function installPathsPath(): string {
  return join(dataDir(), "install.json")
}

/**
 * Records where Observer's executables are, for the plugin to autostart from.
 *
 * Best-effort: a read-only data directory must not fail an install, because the
 * pointer only saves the plugin one fallback (the OBSERVER_DAEMON environment
 * variable), never gates the rest of Observer.
 */
export function recordInstallPaths(): void {
  try {
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(
      installPathsPath(),
      `${JSON.stringify(
        { node: nodePath(), daemon: daemonPath(), emitter: emitterPath(), recordedAt: new Date().toISOString() },
        null,
        2,
      )}\n`,
    )
  } catch {
    // Nothing depends on this succeeding.
  }
}

/** Quotes a path for hosts whose hook format only accepts a shell string. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function hookShellCommand(host: string, event: string): string {
  return `${shellQuote(nodePath())} ${shellQuote(emitterPath())} --host ${host} --event ${event}`
}

export function hookPowershellCommand(host: string, event: string): string {
  return `& "${nodePath()}" "${emitterPath()}" --host ${host} --event ${event}`
}

/** Absolute path to the synchronous Claude subagent admission controller. */
export function claudeControlPath(): string {
  return controlPath("claude-control.js")
}

/** Absolute path to the synchronous Codex spawn controller. */
export function codexControlPath(): string {
  return controlPath("codex-control.js")
}

function controlPath(file: string): string {
  const candidates = [
    resolve(here(), `./${file}`),
    resolve(here(), `../../hook-emitter/dist/${file}`),
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  try {
    return require.resolve(`@observer-ai/hook-emitter/dist/${file}`)
  } catch {
    return candidates[0] as string
  }
}

/** Absolute path to the portable Observer coordination MCP server. */
export function coordinationMcpPath(): string {
  const candidates = [
    resolve(here(), "./coordination-mcp.js"), // published package
    resolve(here(), "../../hook-emitter/dist/coordination-mcp.js"), // monorepo
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found) return found
  try {
    return require.resolve("@observer-ai/hook-emitter/dist/coordination-mcp.js")
  } catch {
    return candidates[0] as string
  }
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Builds one Windows command that survives both Codex runner shapes: its raw
 * `cmd.exe /C` wrapper and a configured PowerShell session shell.
 *
 * The visible command stays quote-free. PowerShell decodes the real invocation
 * and applies its call operator after the outer shell has finished parsing.
 */
export function codexWindowsCommand(
  executable: string,
  script: string,
  host: string,
  event: string,
  scriptRootEnvironment?: string,
): string {
  if (scriptRootEnvironment && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(scriptRootEnvironment)) {
    throw new Error(`Invalid Windows script-root environment name: ${scriptRootEnvironment}`)
  }
  const scriptExpression = scriptRootEnvironment
    ? `(Join-Path $env:${scriptRootEnvironment} ${powershellLiteral(script)})`
    : powershellLiteral(script)
  const payload = `& ${powershellLiteral(executable)} ${scriptExpression} --host ${powershellLiteral(host)} --event ${powershellLiteral(event)}`
  const encoded = Buffer.from(payload, "utf16le").toString("base64")
  const powershell = win32.join(
    process.env["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
  return `${powershell} -NoProfile -NonInteractive -EncodedCommand ${encoded}`
}

export function hookWindowsCommand(
  host: string,
  event: string,
  executable = nodePath(),
  script = emitterPath(),
): string {
  return codexWindowsCommand(executable, script, host, event)
}

export function homeDir(): string {
  return process.env["HOME"] ?? process.env["USERPROFILE"] ?? join("/tmp")
}

/**
 * The root OpenCode reads its user-level configuration from.
 *
 * Lives here rather than in `install.ts` so `seat-agents.ts` can resolve the
 * agent directory without importing the installer that imports it back.
 */
export function opencodeConfigBase(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]
  return xdg && xdg.length > 0 ? xdg : join(homeDir(), ".config")
}

/**
 * The directory OpenCode scans for agent definitions.
 *
 * OpenCode globs `{agent,agents}/**\/*.md` under its config root and names each
 * agent after the file, so everything Observer drops in here becomes a
 * selectable `subagent_type`.
 */
export function opencodeAgentDir(): string {
  return join(opencodeConfigBase(), "opencode", "agent")
}

/** Codex's own state directory. */
export function codexHome(): string {
  const override = process.env["CODEX_HOME"]
  return override && override.length > 0 ? override : join(homeDir(), ".codex")
}

/** Copilot CLI's own state directory. */
export function copilotHome(): string {
  const override = process.env["COPILOT_HOME"]
  return override && override.length > 0 ? override : join(homeDir(), ".copilot")
}

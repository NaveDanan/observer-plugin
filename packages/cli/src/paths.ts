import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

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

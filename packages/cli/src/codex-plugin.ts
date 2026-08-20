import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import type { InstallResult } from "./install.js"
import { HOST_EVENTS } from "./install.js"
import { codexHome, emitterPath, homeDir, nodePath, shellQuote } from "./paths.js"

/**
 * Codex plugin packaging.
 *
 * Codex (and the ChatGPT desktop app) can install Observer as a real plugin
 * rather than as raw entries in `~/.codex/hooks.json`. A plugin is a directory
 * with a `.codex-plugin/plugin.json` manifest, offered through a marketplace.
 *
 * Two details make this work without any manual registration:
 *  - A personal marketplace at `~/.agents/plugins/marketplace.json` is
 *    auto-discovered, with paths resolved relative to the home directory.
 *  - Plugin hooks run with `PLUGIN_ROOT` set to the *installed cache copy*, so
 *    the emitter is shipped inside the plugin and referenced through it.
 */

export const CODEX_PLUGIN_NAME = "observer"
const MARKETPLACE_NAME = "observer-local"

/** Where the plugin source lives before Codex copies it into its cache. */
export function codexPluginDir(): string {
  return join(codexHome(), "plugins", CODEX_PLUGIN_NAME)
}

/** The auto-discovered personal marketplace manifest. */
export function personalMarketplacePath(): string {
  return join(homeDir(), ".agents", "plugins", "marketplace.json")
}

export function isCodexPluginInstalled(): boolean {
  return existsSync(join(codexPluginDir(), ".codex-plugin", "plugin.json"))
}

/**
 * Writes the plugin bundle and registers it in the personal marketplace.
 *
 * Returns `missing` when the plugin would sit outside the home directory,
 * because marketplace entries are resolved relative to the marketplace root
 * and cannot escape it.
 */
export function installCodexPlugin(version: string): InstallResult {
  const pluginDir = codexPluginDir()
  const marketplacePath = personalMarketplacePath()
  const existed = isCodexPluginInstalled()

  const relativePath = toPosixRelative(homeDir(), pluginDir)
  if (!relativePath) {
    return {
      host: "codex",
      action: "missing",
      path: pluginDir,
      notes: [
        `CODEX_HOME (${codexHome()}) is outside your home directory, so it cannot be referenced`,
        "by the auto-discovered personal marketplace. Use `observer install codex` instead.",
      ],
    }
  }

  // 1. Plugin manifest.
  mkdirSync(join(pluginDir, ".codex-plugin"), { recursive: true })
  writeJson(join(pluginDir, ".codex-plugin", "plugin.json"), {
    name: CODEX_PLUGIN_NAME,
    version,
    description: "Interactive canvas for the coding agents you are already running.",
    author: { name: "Observer" },
    license: "MIT",
    keywords: ["observability", "agents", "canvas"],
    hooks: "./hooks/hooks.json",
  })

  // 2. Lifecycle hooks, generated from the same event list the plain install uses.
  mkdirSync(join(pluginDir, "hooks"), { recursive: true })
  const hooks: Record<string, unknown> = {}
  for (const event of HOST_EVENTS.codex) {
    hooks[event] = [
      {
        hooks: [
          {
            type: "command",
            // PLUGIN_ROOT resolves to the installed cache copy of this plugin,
            // so the emitter shipped alongside is always the one that runs.
            command: `${shellQuote(nodePath())} "$PLUGIN_ROOT/scripts/emit.js" --host codex --event ${event}`,
            timeout: 5,
            statusMessage: "Observer",
          },
        ],
      },
    ]
  }
  writeJson(join(pluginDir, "hooks", "hooks.json"), { description: "Observer agent telemetry", hooks })

  // 3. The emitter itself, so the plugin is self-contained once cached.
  mkdirSync(join(pluginDir, "scripts"), { recursive: true })
  const emitter = emitterPath()
  if (!existsSync(emitter)) {
    return { host: "codex", action: "missing", path: emitter, notes: ["Hook emitter not found; reinstall Observer."] }
  }
  copyFileSync(emitter, join(pluginDir, "scripts", "emit.js"))

  // 4. Register in the personal marketplace, preserving anything already there.
  const marketplace = readJson(marketplacePath) ?? {
    name: MARKETPLACE_NAME,
    interface: { displayName: "Observer (local)" },
    plugins: [],
  }
  const plugins = Array.isArray(marketplace["plugins"]) ? (marketplace["plugins"] as unknown[]) : []
  const kept = plugins.filter((entry) => !isObserverPlugin(entry))
  kept.push({
    name: CODEX_PLUGIN_NAME,
    description: "Interactive canvas for the coding agents you are already running.",
    version,
    source: { source: "local", path: relativePath },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  })
  marketplace["plugins"] = kept
  writeJson(marketplacePath, marketplace)

  const marketplaceName = typeof marketplace["name"] === "string" ? marketplace["name"] : MARKETPLACE_NAME
  return {
    host: "codex",
    action: existed ? "updated" : "installed",
    path: pluginDir,
    notes: [
      `Registered in ${marketplacePath} as ${CODEX_PLUGIN_NAME}@${marketplaceName}.`,
      "Restart the ChatGPT desktop app, then install Observer from the Plugins directory.",
      `CLI equivalent: codex plugin add ${CODEX_PLUGIN_NAME}@${marketplaceName}`,
      "Then run /hooks inside Codex and trust the Observer entries.",
    ],
  }
}

export function uninstallCodexPlugin(): InstallResult {
  const pluginDir = codexPluginDir()
  const marketplacePath = personalMarketplacePath()
  let removed = false

  if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true })
    removed = true
  }

  const marketplace = readJson(marketplacePath)
  if (marketplace && Array.isArray(marketplace["plugins"])) {
    const plugins = marketplace["plugins"] as unknown[]
    const kept = plugins.filter((entry) => !isObserverPlugin(entry))
    if (kept.length !== plugins.length) removed = true
    if (kept.length === 0 && marketplace["name"] === MARKETPLACE_NAME) {
      // The marketplace was Observer's own; take it with us.
      rmSync(marketplacePath, { force: true })
    } else {
      marketplace["plugins"] = kept
      writeJson(marketplacePath, marketplace)
    }
  }

  return {
    host: "codex",
    action: removed ? "removed" : "unchanged",
    path: pluginDir,
    notes: removed
      ? [
          "Codex keeps its own installed copy in the plugin cache.",
          `Remove it with: codex plugin remove ${CODEX_PLUGIN_NAME}@${MARKETPLACE_NAME}`,
        ]
      : ["Nothing to remove."],
  }
}

function isObserverPlugin(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null && (entry as { name?: unknown }).name === CODEX_PLUGIN_NAME
}

/** Marketplace paths must be `./`-prefixed and stay inside the marketplace root. */
function toPosixRelative(root: string, target: string): string | undefined {
  const rel = relative(root, target)
  if (rel.length === 0 || rel.startsWith("..") || rel.includes(`..${sep}`)) return undefined
  return `./${rel.split(sep).join("/")}`
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

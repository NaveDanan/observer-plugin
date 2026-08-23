import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { InstallResult } from "./install.js"
import { HOST_EVENTS } from "./install.js"
import { syncCopilotSeatAgents, removeCopilotSeatSettings } from "./copilot-seat-agents.js"
import { loadConfig } from "@observer-ai/daemon"
import { copilotControlPath, copilotHome, emitterPath, nodePath, shellQuote } from "./paths.js"

/**
 * Copilot CLI plugin packaging.
 *
 * Copilot CLI has a first-class plugin system, separate from the raw hook file
 * at `~/.copilot/hooks/observer.json`. A plugin is a directory with a
 * `plugin.json` manifest that may carry hooks, agents, skills and MCP servers.
 * Installing it is what makes Observer appear in `copilot plugin list` and in
 * the desktop app's plugins dashboard — copying files into
 * `~/.copilot/installed-plugins/` by hand does not, because the CLI also
 * records installed-plugin metadata of its own.
 *
 * Two decisions worth stating:
 *
 *  - **The source directory is Observer's, not Copilot's.** `copilot plugin
 *    install <path>` copies the directory into its own cache, so this is only
 *    the staging area. Keeping it under `~/.observer` means `observer
 *    uninstall copilot --plugin` has something it owns outright to delete.
 *
 *  - **Hooks use absolute paths, not `${PLUGIN_ROOT}`.** Copilot documents
 *    `${PLUGIN_ROOT}` for LSP configuration, but does not promise it is
 *    expanded in hook command strings. Absolute executable paths are the
 *    same thing the plain hook install already uses and is known to work, so
 *    the plugin ships copies for provenance while hooks reference installed
 *    executables.
 */

export const COPILOT_PLUGIN_NAME = "observer"
const HOOK_TIMEOUT_SECONDS = 5

export interface CopilotRun {
  ok: boolean
  output: string
  reason: string
}

/**
 * How the plugin talks to the Copilot CLI.
 *
 * Injectable so the installer can be tested without a real `copilot` on PATH —
 * and, more to the point, without a test actually installing a plugin into the
 * developer's own Copilot.
 */
export type CopilotRunner = (args: string[]) => CopilotRun

/** Where the plugin is staged before Copilot copies it into its cache. */
export function copilotPluginDir(): string {
  return join(copilotHome(), "plugins", COPILOT_PLUGIN_NAME)
}

export function copilotPluginManifestPath(): string {
  return join(copilotPluginDir(), "plugin.json")
}

export function isCopilotPluginStaged(): boolean {
  return existsSync(copilotPluginManifestPath())
}

/** Whether Copilot itself reports the plugin as installed. */
export function isCopilotPluginInstalled(run: CopilotRunner = runCopilot): boolean {
  const listed = run(["plugin", "list"])
  return listed.ok && listed.output.includes(COPILOT_PLUGIN_NAME)
}

/**
 * Stages the plugin directory and asks Copilot to install it.
 *
 * The staging always happens; the install is attempted and reported on, but a
 * missing `copilot` binary is a note rather than a failure, because the
 * directory it would have installed is still there to point at.
 */
export function installCopilotPlugin(version: string, run: CopilotRunner = runCopilot): InstallResult {
  const pluginDir = copilotPluginDir()
  const existed = isCopilotPluginStaged()

  const emitter = emitterPath()
  if (!existsSync(emitter)) {
    return { host: "copilot", action: "missing", path: emitter, notes: ["Hook emitter not found; reinstall Observer."] }
  }
  const controller = copilotControlPath()
  if (!existsSync(controller)) {
    return {
      host: "copilot",
      action: "missing",
      path: controller,
      notes: ["Copilot seat controller not found; reinstall Observer."],
    }
  }

  // 1. Manifest. `hooks` points at the conventional location explicitly so the
  //    file is self-describing rather than relying on discovery.
  mkdirSync(pluginDir, { recursive: true })
  writeJson(copilotPluginManifestPath(), {
    name: COPILOT_PLUGIN_NAME,
    description: "Interactive canvas for the coding agents you are already running.",
    version,
    author: { name: "Observer" },
    license: "MIT",
    keywords: ["observability", "agents", "canvas"],
    category: "Productivity",
    agents: "agents/",
    hooks: "hooks/hooks.json",
  })

  // 2. Lifecycle hooks, generated from the same event list the plain install
  //    uses, so the two integrations can never drift apart.
  mkdirSync(join(pluginDir, "hooks"), { recursive: true })
  const hooks: Record<string, unknown> = {}
  for (const event of HOST_EVENTS.copilot) {
    const entries: Record<string, unknown>[] = []
    if (event === "preToolUse") {
      entries.push({
        type: "command",
        matcher: "task",
        bash: `${shellQuote(nodePath())} ${shellQuote(controller)}`,
        powershell: `& "${nodePath()}" "${controller}"`,
        timeoutSec: 3,
      })
    }
    entries.push({
      type: "command",
      bash: `${shellQuote(nodePath())} ${shellQuote(emitter)} --host copilot --event ${event}`,
      powershell: `& "${nodePath()}" "${emitter}" --host copilot --event ${event}`,
      timeoutSec: HOOK_TIMEOUT_SECONDS,
    })
    hooks[event] = entries
  }
  writeJson(join(pluginDir, "hooks", "hooks.json"), { version: 1, hooks })

  // 3. A copy of the emitter, so the installed plugin is inspectable on its own.
  mkdirSync(join(pluginDir, "scripts"), { recursive: true })
  copyFileSync(emitter, join(pluginDir, "scripts", "emit.js"))
  copyFileSync(controller, join(pluginDir, "scripts", "copilot-control.js"))

  const notes = [
    "The plugin carries the same hooks as the plain install; use one or the other, not both.",
  ]
  try {
    notes.push(...syncCopilotSeatAgents(loadConfig().seats).notes)
  } catch (error) {
    notes.push(`Seat agents were not generated: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 4. Hand it to Copilot. This is the step that makes it appear in the
  //    plugins list — staging alone is invisible to the CLI.
  const install = run(["plugin", "install", pluginDir])
  if (install.ok) {
    notes.push("Installed with `copilot plugin install`; it now appears in `copilot plugin list`.")
    notes.push("Restart Copilot CLI (and the desktop app) so the session picks it up.")
  } else {
    notes.push(`Could not run \`copilot plugin install\` automatically (${install.reason}).`)
    notes.push(`Finish by hand with: copilot plugin install ${pluginDir}`)
  }

  return { host: "copilot", action: existed ? "updated" : "installed", path: pluginDir, notes }
}

export function uninstallCopilotPlugin(run: CopilotRunner = runCopilot): InstallResult {
  const pluginDir = copilotPluginDir()
  let removed = false
  const notes: string[] = removeCopilotSeatSettings()

  // Ask Copilot to forget it first: removing the staging directory underneath
  // an installed plugin would leave the CLI listing something with no source.
  const remove = run(["plugin", "uninstall", COPILOT_PLUGIN_NAME])
  if (remove.ok) {
    removed = true
    notes.push("Removed with `copilot plugin uninstall`.")
  } else {
    notes.push(`Could not run \`copilot plugin uninstall\` automatically (${remove.reason}).`)
    notes.push(`Finish by hand with: copilot plugin uninstall ${COPILOT_PLUGIN_NAME}`)
  }

  if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true })
    removed = true
  }

  return {
    host: "copilot",
    action: removed ? "removed" : "unchanged",
    path: pluginDir,
    notes: removed ? notes : ["Nothing to remove."],
  }
}

/**
 * Runs the Copilot CLI, treating "not installed" as an ordinary answer.
 *
 * Observer must stay installable on a machine where Copilot is absent, so this
 * never throws: the caller turns a failure into a note telling the user the one
 * command to run themselves.
 */
export function runCopilot(args: string[]): CopilotRun {
  try {
    const result = spawnSync("copilot", args, {
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 60_000,
      windowsHide: true,
    })
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    if (result.error) return { ok: false, output, reason: result.error.message }
    if (result.status !== 0) {
      const detail = output.trim().split("\n").pop() ?? `exit ${String(result.status)}`
      return { ok: false, output, reason: detail }
    }
    return { ok: true, output, reason: "" }
  } catch (error) {
    return { ok: false, output: "", reason: error instanceof Error ? error.message : "copilot not available" }
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

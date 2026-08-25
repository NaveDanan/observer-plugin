import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  COPILOT_PLUGIN_NAME,
  copilotPluginDir,
  copilotPluginManifestPath,
  installCopilotPlugin,
  isCopilotPluginStaged,
  uninstallCopilotPlugin,
} from "../dist/index.js"
import type { CopilotRun } from "../dist/index.js"

/**
 * The Copilot CLI plugin bundle.
 *
 * Every test here injects a fake runner. A real `copilot plugin install` would
 * install Observer into the machine running the suite, which is not a thing a
 * unit test gets to do.
 */

let home: string
let originalHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer-copilot-"))
  originalHome = process.env["HOME"]
  process.env["HOME"] = home
  delete process.env["COPILOT_HOME"]
})

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"]
  else process.env["HOME"] = originalHome
  delete process.env["COPILOT_HOME"]
  rmSync(home, { recursive: true, force: true })
})

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
}

function recorder(result: Partial<CopilotRun> = {}): { calls: string[][]; run: (args: string[]) => CopilotRun } {
  const calls: string[][] = []
  return {
    calls,
    run: (args: string[]) => {
      calls.push(args)
      return { ok: true, output: "", reason: "", ...result }
    },
  }
}

describe("installCopilotPlugin", () => {
  it("writes a manifest Copilot can discover", () => {
    const { run } = recorder()
    const result = installCopilotPlugin("1.2.3", run)
    expect(result.action).toBe("installed")

    // The manifest must sit at the plugin root under exactly this name: it is
    // one of the four paths Copilot checks, and the only one that needs no
    // extra directory.
    const manifest = readJson(copilotPluginManifestPath())
    expect(manifest["name"]).toBe(COPILOT_PLUGIN_NAME)
    expect(manifest["version"]).toBe("1.2.3")
    expect(manifest["hooks"]).toBe("hooks/hooks.json")
    expect(manifest["agents"]).toBe("agents/")
    expect(isCopilotPluginStaged()).toBe(true)
  })

  it("subscribes to every Copilot event the plain hook install uses", () => {
    const { run } = recorder()
    installCopilotPlugin("1.0.0", run)
    const hooks = readJson(join(copilotPluginDir(), "hooks", "hooks.json"))

    expect(hooks["version"]).toBe(1)
    expect(Object.keys(hooks["hooks"]).sort()).toEqual(
      [
        "agentStop",
        "errorOccurred",
        "postToolUse",
        "postToolUseFailure",
        "preToolUse",
        "sessionEnd",
        "sessionStart",
        "subagentStart",
        "subagentStop",
        "userPromptSubmitted",
      ].sort(),
    )
  })

  it("ships both shells so the same bundle works on Windows", () => {
    const { run } = recorder()
    installCopilotPlugin("1.0.0", run)
    const hooks = readJson(join(copilotPluginDir(), "hooks", "hooks.json"))
    const entry = hooks["hooks"]["sessionStart"][0]

    expect(entry.type).toBe("command")
    expect(entry.timeoutSec).toBe(5)
    expect(entry.bash).toContain("--host copilot --event sessionStart")
    expect(entry.powershell).toContain("--host copilot --event sessionStart")
    // Absolute, not ${PLUGIN_ROOT}: Copilot documents that variable for LSP
    // configuration and does not promise it in hook command strings.
    expect(entry.bash).not.toContain("PLUGIN_ROOT")
    expect(entry.powershell).not.toContain("PLUGIN_ROOT")
  })

  it("does not install a routing controller for task calls", () => {
    const { run } = recorder()
    installCopilotPlugin("1.0.0", run)
    const hooks = readJson(join(copilotPluginDir(), "hooks", "hooks.json"))
    const entries = hooks["hooks"]["preToolUse"]

    expect(entries).toHaveLength(1)
    expect(entries[0].matcher).toBeUndefined()
    expect(entries[0].bash).not.toContain("copilot-control.js")
    expect(entries[0].bash).toContain("--host copilot --event preToolUse")
  })

  it("hands the staged directory to `copilot plugin install`", () => {
    const { calls, run } = recorder()
    const result = installCopilotPlugin("1.0.0", run)

    expect(calls).toEqual([["plugin", "install", copilotPluginDir()]])
    expect(result.notes.join(" ")).toContain("copilot plugin list")
  })

  it("still stages the bundle when copilot is not on PATH, and says what to run", () => {
    const { run } = recorder({ ok: false, reason: "spawn copilot ENOENT" })
    const result = installCopilotPlugin("1.0.0", run)

    // Staging is the part Observer controls, so it must survive a missing host.
    expect(result.action).toBe("installed")
    expect(existsSync(copilotPluginManifestPath())).toBe(true)
    expect(result.notes.join("\n")).toContain(`copilot plugin install ${copilotPluginDir()}`)
  })

  it("reports a second install as an update rather than a fresh one", () => {
    const { run } = recorder()
    installCopilotPlugin("1.0.0", run)
    expect(installCopilotPlugin("1.0.1", run).action).toBe("updated")
    expect(readJson(copilotPluginManifestPath())["version"]).toBe("1.0.1")
  })
})

describe("uninstallCopilotPlugin", () => {
  it("tells Copilot first, then removes the staging directory", () => {
    const { calls, run } = recorder()
    installCopilotPlugin("1.0.0", run)
    calls.length = 0

    const result = uninstallCopilotPlugin(run)
    expect(calls).toEqual([["plugin", "uninstall", COPILOT_PLUGIN_NAME]])
    expect(result.action).toBe("removed")
    expect(existsSync(copilotPluginDir())).toBe(false)
  })

  it("is a no-op when nothing was ever installed", () => {
    const { run } = recorder({ ok: false, reason: "not installed" })
    expect(uninstallCopilotPlugin(run).action).toBe("unchanged")
  })
})

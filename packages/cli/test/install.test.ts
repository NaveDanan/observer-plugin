import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { HOST_EVENTS, hostConfigPath, install, isInstalled, seatAgentDir, syncSeatAgents, uninstall } from "../dist/index.js"

let home: string
let originalHome: string | undefined
let originalObserverHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer-cli-"))
  originalHome = process.env["HOME"]
  originalObserverHome = process.env["OBSERVER_HOME"]
  process.env["HOME"] = home
  // `install("opencode")` reads the Observer config to reconcile seat agents.
  // Redirect it: a test must never read or write the developer's own config.
  process.env["OBSERVER_HOME"] = join(home, ".observer")
  delete process.env["XDG_CONFIG_HOME"]
  delete process.env["CODEX_HOME"]
  delete process.env["COPILOT_HOME"]
})

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"]
  else process.env["HOME"] = originalHome
  if (originalObserverHome === undefined) delete process.env["OBSERVER_HOME"]
  else process.env["OBSERVER_HOME"] = originalObserverHome
  rmSync(home, { recursive: true, force: true })
})

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
}

describe("install", () => {
  it("installs every host and reports it", () => {
    for (const host of ["claude", "codex", "copilot", "opencode"] as const) {
      const result = install(host)
      expect(result.action).toBe("installed")
      expect(existsSync(result.path)).toBe(true)
      expect(isInstalled(host)).toBe(true)
    }
  })

  it("subscribes Claude to every event Observer understands", () => {
    install("claude")
    const settings = readJson(hostConfigPath("claude"))
    expect(Object.keys(settings["hooks"]).sort()).toEqual([...HOST_EVENTS.claude].sort())
    const entry = settings["hooks"]["PreToolUse"][0].hooks[0]
    // Exec form avoids shell quoting problems in paths.
    expect(entry.args).toContain("--host")
    expect(entry.statusMessage).toBe("Observer")
  })

  it("is idempotent: reinstalling does not duplicate entries", () => {
    install("claude")
    install("claude")
    const settings = readJson(hostConfigPath("claude"))
    expect(settings["hooks"]["SessionStart"]).toHaveLength(1)
  })

  it("preserves unrelated user configuration", () => {
    const path = hostConfigPath("claude")
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/guard.sh" }] }] },
      }),
    )

    install("claude")
    uninstall("claude")

    const settings = readJson(path)
    expect(settings["permissions"]).toEqual({ allow: ["Read"] })
    expect(settings["hooks"]["PreToolUse"]).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/guard.sh" }] },
    ])
  })

  it("writes Copilot hooks with both bash and powershell commands", () => {
    install("copilot")
    const document = readJson(hostConfigPath("copilot"))
    expect(document["version"]).toBe(1)
    const entry = document["hooks"]["preToolUse"][0]
    expect(entry.bash).toContain("--host copilot")
    expect(entry.powershell).toContain("--host copilot")
    expect(entry.timeoutSec).toBe(5)
  })

  it("writes Codex hooks with platform-specific commands", () => {
    install("codex")
    const document = readJson(hostConfigPath("codex"))
    const entry = document["hooks"]["SessionStart"][0].hooks[0]
    expect(entry.command).toContain("--host codex --event SessionStart")
    expect(entry.commandWindows).toContain("WindowsPowerShell\\v1.0\\powershell.exe")
    expect(entry.commandWindows).toContain("-EncodedCommand")
    expect(entry.statusMessage).toBe("Observer")
    expect(document["hooks"]["SessionEnd"][0].hooks[0].timeout).toBe(3)
  })

  it("honours CODEX_HOME and XDG_CONFIG_HOME", () => {
    process.env["CODEX_HOME"] = join(home, "custom-codex")
    process.env["XDG_CONFIG_HOME"] = join(home, "custom-config")
    expect(hostConfigPath("codex")).toBe(join(home, "custom-codex", "hooks.json"))
    expect(hostConfigPath("opencode")).toBe(join(home, "custom-config", "opencode", "plugins", "observer.js"))
  })

  it("installs the @observer agent definition beside the OpenCode plugin", () => {
    const result = install("opencode")
    expect(result.action).toBe("installed")
    // The agent definition is what puts @observer in OpenCode's @ menu.
    const agentPath = join(dirname(hostConfigPath("opencode")), "..", "agent", "observer.md")
    expect(existsSync(agentPath)).toBe(true)
    expect(readFileSync(agentPath, "utf8")).toContain("mode: subagent")
  })

  it("removes the @observer agent definition on uninstall", () => {
    install("opencode")
    uninstall("opencode")
    const agentPath = join(dirname(hostConfigPath("opencode")), "..", "agent", "observer.md")
    expect(existsSync(agentPath)).toBe(false)
  })

  it("removes generated seat agents on uninstall, alongside the plugin and observer.md", () => {
    install("opencode")
    syncSeatAgents({ control: true, employees: { "arjun-mehta": { model: "anthropic/claude-opus-4-5" } } } as any)
    const seatPath = join(seatAgentDir(), "observer-arjun-mehta.md")
    expect(existsSync(seatPath)).toBe(true)

    const result = uninstall("opencode")

    // A definition naming a model the user chose through Observer must not
    // outlive Observer: it would keep steering delegations after the plugin
    // that explains it is gone.
    expect(existsSync(seatPath)).toBe(false)
    expect(existsSync(hostConfigPath("opencode"))).toBe(false)
    expect(existsSync(join(seatAgentDir(), "observer.md"))).toBe(false)
    expect(result.action).toBe("removed")
    expect(result.notes.join("\n")).toContain("14 generated seat agent definitions")
  })
})

describe("uninstall", () => {
  it("removes hooks and the OpenCode plugin", () => {
    for (const host of ["claude", "codex", "copilot", "opencode"] as const) {
      install(host)
      const result = uninstall(host)
      expect(result.action).toBe("removed")
      expect(isInstalled(host)).toBe(false)
    }
  })

  it("leaves no litter behind when the file was Observer's own", () => {
    install("codex")
    uninstall("codex")

    const path = hostConfigPath("codex")
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.observer-backup`)).toBe(false)
  })

  it("keeps a user-owned file but drops the backup copy", () => {
    const path = hostConfigPath("claude")
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ permissions: { allow: ["Read"] } }))

    install("claude")
    uninstall("claude")

    expect(readJson(path)["permissions"]).toEqual({ allow: ["Read"] })
    expect(readJson(path)["hooks"]).toBeUndefined()
    expect(existsSync(`${path}.observer-backup`)).toBe(false)
  })

  it("is safe when nothing is installed", () => {
    expect(uninstall("claude").action).toBe("unchanged")
    expect(uninstall("opencode").action).toBe("unchanged")
  })

  it("reports removing seat agents alone, without claiming it removed a plugin it never found", () => {
    // Seat definitions can outlive the plugin: `observer uninstall opencode`
    // run twice, or a config directory restored from a backup. The second run
    // must not narrate a plugin removal that did not happen.
    syncSeatAgents({ control: true, employees: { "arjun-mehta": { model: "anthropic/claude-opus-4-5" } } } as any)
    const result = uninstall("opencode")

    expect(result.action).toBe("removed")
    expect(result.notes.join("\n")).toContain("14 generated seat agent definitions")
    expect(result.notes.join("\n")).not.toContain("Removed the Observer plugin")
  })
})

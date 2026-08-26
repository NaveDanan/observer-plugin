import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EMPLOYEES } from "@observer-ai/roster"
import {
  CODEX_PLUGIN_NAME,
  codexPluginDir,
  hookWindowsCommand,
  installCodexPlugin,
  isCodexPluginInstalled,
  personalMarketplacePath,
  uninstallCodexPlugin,
} from "../dist/index.js"

let home: string
let originalHome: string | undefined

function recorderScript(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'process.stdout.write(JSON.stringify(process.argv.slice(1)))\n')
}

function useSpacedNodePath(): () => void {
  const original = process.execPath
  if (original.includes(" ")) return () => {}
  const spaced = join(home, "node runtime", "node.exe")
  mkdirSync(dirname(spaced), { recursive: true })
  try {
    linkSync(original, spaced)
  } catch {
    copyFileSync(original, spaced)
  }
  process.execPath = spaced
  return () => {
    process.execPath = original
  }
}

function runAsCodex(commandWindows: string, extraEnv: Record<string, string> = {}): string[] {
  const comspec = process.env["ComSpec"] ?? "cmd.exe"
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"))
  const rawCommandLine = `${comspec} /d /s /c "${commandWindows}"`
  const result = spawnSync(comspec, ["/d", "/s", "/c", `"${commandWindows}"`], {
    encoding: "utf8",
    env: { ...env, ...extraEnv },
    // Codex uses CommandExt::raw_arg for this literal outer quote pair. Normal
    // argv escaping is a different parser path and gives a false green here.
    windowsVerbatimArguments: true,
  })
  expect(result.status, `${rawCommandLine}\n${result.stderr || result.error?.message}`).toBe(0)
  return JSON.parse(result.stdout) as string[]
}

function runThroughPowerShell(commandWindows: string, extraEnv: Record<string, string> = {}): string[] {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"))
  const powershell = join(
    process.env["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", commandWindows], {
    encoding: "utf8",
    env: { ...env, ...extraEnv },
  })
  expect(result.status, `${powershell} -NoProfile -Command ${commandWindows}\n${result.stderr || result.error?.message}`).toBe(0)
  return JSON.parse(result.stdout) as string[]
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer codex "))
  originalHome = process.env["HOME"]
  process.env["HOME"] = home
  delete process.env["CODEX_HOME"]
})

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"]
  else process.env["HOME"] = originalHome
  delete process.env["CODEX_HOME"]
  rmSync(home, { recursive: true, force: true })
})

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>
}

describe("installCodexPlugin", () => {
  it.runIf(process.platform === "win32")(
    "executes a direct hook with spaced paths through Codex's cmd and PowerShell runners",
    () => {
      const restoreNodePath = useSpacedNodePath()
      const recorder = join(home, "direct hook scripts", "record args.js")
      recorderScript(recorder)

      try {
        const commandWindows = hookWindowsCommand("codex", "SessionStart", process.execPath, recorder)
        const expected = [
          recorder,
          "--host",
          "codex",
          "--event",
          "SessionStart",
        ]
        expect(runAsCodex(commandWindows)).toEqual(expected)
        expect(runThroughPowerShell(commandWindows)).toEqual(expected)
      } finally {
        restoreNodePath()
      }
    },
  )

  it.runIf(process.platform === "win32")(
    "executes a packaged hook with a spaced PLUGIN_ROOT through both Windows runners",
    () => {
      const restoreNodePath = useSpacedNodePath()
      try {
        installCodexPlugin("1.0.0")
        const pluginRoot = codexPluginDir()
        const recorder = join(pluginRoot, "scripts", "emit.js")
        recorderScript(recorder)
        const hooks = readJson(join(pluginRoot, "hooks", "hooks.json"))
        const commandWindows = hooks["hooks"]["SessionStart"][0].hooks[0].commandWindows as string

        const expected = [
          recorder,
          "--host",
          "codex",
          "--event",
          "SessionStart",
        ]
        expect(runAsCodex(commandWindows, { PLUGIN_ROOT: pluginRoot })).toEqual(expected)
        expect(runThroughPowerShell(commandWindows, { PLUGIN_ROOT: pluginRoot })).toEqual(expected)
      } finally {
        restoreNodePath()
      }
    },
  )

  it("writes a complete, self-contained plugin bundle", () => {
    const result = installCodexPlugin("1.2.3")
    expect(result.action).toBe("installed")

    const dir = codexPluginDir()
    const manifest = readJson(join(dir, ".codex-plugin", "plugin.json"))
    expect(manifest["name"]).toBe(CODEX_PLUGIN_NAME)
    expect(manifest["version"]).toBe("1.2.3")
    expect(manifest).not.toHaveProperty("hooks")
    expect(manifest["interface"]).toMatchObject({
      displayName: "Observer",
      category: "Developer Tools",
    })

    // The emitter ships inside the plugin so the cached copy is runnable.
    expect(existsSync(join(dir, "scripts", "emit.js"))).toBe(true)
    expect(isCodexPluginInstalled()).toBe(true)
  })

  it("ships an explicit @observer skill with the complete employee roster and delegation policy", () => {
    installCodexPlugin("1.2.3")

    const skill = readFileSync(join(codexPluginDir(), "skills", "observer", "SKILL.md"), "utf8")
    expect(skill).toContain("Use only when the user explicitly invokes @observer")
    expect(skill).toContain('fork_turns: "none"')
    expect(skill).toContain("state the reason")
    for (const profile of EMPLOYEES) {
      expect(skill).toContain(profile.fullName)
      for (const field of profile.fields) expect(skill).toContain(field)
    }
  })

  it("references the emitter through PLUGIN_ROOT, not an absolute plugin path", () => {
    installCodexPlugin("1.0.0")
    const hooks = readJson(join(codexPluginDir(), "hooks", "hooks.json"))
    const entry = hooks["hooks"]["SessionStart"][0].hooks[0]
    const command = entry.command as string
    const commandWindows = entry.commandWindows as string

    // PLUGIN_ROOT points at Codex's installed cache copy, which is the only
    // location guaranteed to exist when the hook actually runs.
    expect(command).toContain('"$PLUGIN_ROOT/scripts/emit.js"')
    expect(command).toContain("--host codex --event SessionStart")
    expect(command).not.toContain(codexPluginDir())

    expect(commandWindows).toContain("WindowsPowerShell\\v1.0\\powershell.exe")
    expect(commandWindows).toContain("-EncodedCommand")
    expect(commandWindows).not.toContain(process.execPath)
    expect(commandWindows).not.toContain("PLUGIN_ROOT")
  })

  it("uses Codex's supported SessionEnd timeout without clamping", () => {
    installCodexPlugin("1.0.0")
    const hooks = readJson(join(codexPluginDir(), "hooks", "hooks.json"))["hooks"]

    expect(hooks["SessionStart"][0].hooks[0].timeout).toBe(5)
    expect(hooks["SessionEnd"][0].hooks[0].timeout).toBe(3)
  })

  it("uses a valid semantic version for development builds", () => {
    installCodexPlugin("dev")
    const manifest = readJson(join(codexPluginDir(), ".codex-plugin", "plugin.json"))

    expect(manifest["version"]).toBe("0.0.0-dev")
  })

  it("subscribes to every Codex event Observer understands", () => {
    installCodexPlugin("1.0.0")
    const hooks = readJson(join(codexPluginDir(), "hooks", "hooks.json"))["hooks"]
    expect(Object.keys(hooks)).toContain("SubagentStart")
    expect(Object.keys(hooks)).toContain("PostToolUse")
    expect(Object.keys(hooks).length).toBeGreaterThanOrEqual(10)
    expect(hooks["PreToolUse"][0].hooks).toHaveLength(2)
    expect(hooks["PreToolUse"][0].hooks[0].command).toContain("codex-control.js")
    expect(hooks["PostToolUse"][0].hooks).toHaveLength(1)
  })

  it("registers a home-relative path in the personal marketplace", () => {
    installCodexPlugin("1.0.0")
    const marketplace = readJson(personalMarketplacePath())
    const entry = marketplace["plugins"][0]

    // Marketplace paths resolve against the marketplace root, which for the
    // auto-discovered personal marketplace is the home directory.
    expect(entry["source"]).toEqual({ source: "local", path: "./.codex/plugins/observer" })
    expect(entry["policy"]["installation"]).toBe("AVAILABLE")
  })

  it("is idempotent", () => {
    installCodexPlugin("1.0.0")
    const second = installCodexPlugin("1.0.0")
    expect(second.action).toBe("updated")
    expect(readJson(personalMarketplacePath())["plugins"]).toHaveLength(1)
  })

  it("preserves plugins other tools registered in the same marketplace", () => {
    const path = personalMarketplacePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        name: "my-plugins",
        plugins: [{ name: "something-else", source: { source: "local", path: "./other" } }],
      }),
    )

    installCodexPlugin("1.0.0")

    const marketplace = readJson(path)
    expect(marketplace["name"]).toBe("my-plugins")
    expect(marketplace["plugins"].map((p: { name: string }) => p.name).sort()).toEqual(["observer", "something-else"])
  })

  it("refuses when CODEX_HOME sits outside the home directory", () => {
    process.env["CODEX_HOME"] = mkdtempSync(join(tmpdir(), "observer-codex-out-"))
    const result = installCodexPlugin("1.0.0")

    expect(result.action).toBe("missing")
    expect(result.notes.join(" ")).toContain("outside your home directory")
    rmSync(process.env["CODEX_HOME"]!, { recursive: true, force: true })
  })
})

describe("uninstallCodexPlugin", () => {
  it("removes the bundle and its marketplace entry", () => {
    installCodexPlugin("1.0.0")
    const result = uninstallCodexPlugin()

    expect(result.action).toBe("removed")
    expect(existsSync(codexPluginDir())).toBe(false)
    expect(existsSync(personalMarketplacePath())).toBe(false)
    // Codex caches its own copy, so the user is told how to drop it.
    expect(result.notes.join(" ")).toContain("codex plugin remove")
  })

  it("keeps a marketplace that other plugins still use", () => {
    const path = personalMarketplacePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ name: "my-plugins", plugins: [{ name: "other" }] }))

    installCodexPlugin("1.0.0")
    uninstallCodexPlugin()

    expect(readJson(path)["plugins"]).toEqual([{ name: "other" }])
  })

  it("is safe when nothing is installed", () => {
    expect(uninstallCodexPlugin().action).toBe("unchanged")
  })
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  CODEX_PLUGIN_NAME,
  codexPluginDir,
  installCodexPlugin,
  isCodexPluginInstalled,
  personalMarketplacePath,
  uninstallCodexPlugin,
} from "../dist/index.js"

let home: string
let originalHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer-codex-"))
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
  it("writes a complete, self-contained plugin bundle", () => {
    const result = installCodexPlugin("1.2.3")
    expect(result.action).toBe("installed")

    const dir = codexPluginDir()
    const manifest = readJson(join(dir, ".codex-plugin", "plugin.json"))
    expect(manifest["name"]).toBe(CODEX_PLUGIN_NAME)
    expect(manifest["version"]).toBe("1.2.3")
    expect(manifest["hooks"]).toBe("./hooks/hooks.json")

    // The emitter ships inside the plugin so the cached copy is runnable.
    expect(existsSync(join(dir, "scripts", "emit.js"))).toBe(true)
    expect(isCodexPluginInstalled()).toBe(true)
  })

  it("references the emitter through PLUGIN_ROOT, not an absolute plugin path", () => {
    installCodexPlugin("1.0.0")
    const hooks = readJson(join(codexPluginDir(), "hooks", "hooks.json"))
    const command = hooks["hooks"]["SessionStart"][0].hooks[0].command as string

    // PLUGIN_ROOT points at Codex's installed cache copy, which is the only
    // location guaranteed to exist when the hook actually runs.
    expect(command).toContain('"$PLUGIN_ROOT/scripts/emit.js"')
    expect(command).toContain("--host codex --event SessionStart")
    expect(command).not.toContain(codexPluginDir())
  })

  it("subscribes to every Codex event Observer understands", () => {
    installCodexPlugin("1.0.0")
    const hooks = readJson(join(codexPluginDir(), "hooks", "hooks.json"))["hooks"]
    expect(Object.keys(hooks)).toContain("SubagentStart")
    expect(Object.keys(hooks)).toContain("PostToolUse")
    expect(Object.keys(hooks).length).toBeGreaterThanOrEqual(10)
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

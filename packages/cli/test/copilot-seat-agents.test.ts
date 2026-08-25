import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  copilotPluginCacheDir,
  copilotSettingsPath,
  copilotSeatStatePath,
  syncCopilotSeatAgents,
} from "../dist/index.js"

let home: string
let originalHome: string | undefined
let originalCopilotHome: string | undefined
let originalObserverHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer-copilot-seats-"))
  originalHome = process.env["HOME"]
  originalCopilotHome = process.env["COPILOT_HOME"]
  originalObserverHome = process.env["OBSERVER_HOME"]
  process.env["HOME"] = home
  process.env["COPILOT_HOME"] = join(home, "copilot")
  process.env["OBSERVER_HOME"] = join(home, "observer")
  mkdirSync(join(home, "copilot", "plugins", "observer"), { recursive: true })
  writeFileSync(join(home, "copilot", "plugins", "observer", "plugin.json"), "{}\n")
})

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"]
  else process.env["HOME"] = originalHome
  if (originalCopilotHome === undefined) delete process.env["COPILOT_HOME"]
  else process.env["COPILOT_HOME"] = originalCopilotHome
  if (originalObserverHome === undefined) delete process.env["OBSERVER_HOME"]
  else process.env["OBSERVER_HOME"] = originalObserverHome
  rmSync(home, { recursive: true, force: true })
})

function seats(control = true) {
  return {
    control,
    employees: {
      "malik-johnson": {
        targets: {
          "copilot:default": {
            host: "copilot",
            model: "claude-opus-5",
            options: [
              { id: "effortLevel", value: "high" },
              { id: "contextTier", value: "long_context" },
            ],
          },
        },
      },
    },
  } as any
}

describe("Copilot seat agents", () => {
  it("generates a plugin agent and reconciles its model settings", () => {
    writeFileSync(
      copilotSettingsPath(),
      `${JSON.stringify({ theme: "github", subagents: { agents: { explore: { model: "gpt-5.6-luna" } } } }, null, 2)}\n`,
    )

    const result = syncCopilotSeatAgents(seats())
    const agent = readFileSync(
      join(process.env["COPILOT_HOME"]!, "plugins", "observer", "agents", "observer-malik-johnson.agent.md"),
      "utf8",
    )
    const settings = JSON.parse(readFileSync(copilotSettingsPath(), "utf8"))

    expect(agent).toContain("observer:copilot-seat-agent v1")
    expect(agent).toContain('model: "claude-opus-5"')
    expect(agent).toContain("You are Malik Johnson")
    expect(agent).toContain("Use `apply_patch` instead of the legacy `edit` and `create` tools")
    expect(settings.theme).toBe("github")
    expect(settings.subagents.agents.explore).toEqual({ model: "gpt-5.6-luna" })
    expect(settings.subagents.agents["observer:observer-malik-johnson"]).toEqual({
      model: "claude-opus-5",
      effortLevel: "high",
      contextTier: "long_context",
    })
    expect(result.notes.join(" ")).toContain("Restart Copilot CLI and the Copilot app")
  })

  it("updates both staging and installed plugin copies", () => {
    mkdirSync(copilotPluginCacheDir(), { recursive: true })
    writeFileSync(join(copilotPluginCacheDir(), "plugin.json"), "{}\n")

    const result = syncCopilotSeatAgents(seats())
    expect(result.written).toHaveLength(2)
    expect(
      existsSync(join(copilotPluginCacheDir(), "agents", "observer-malik-johnson.agent.md")),
    ).toBe(true)
  })

  it("preserves a colliding agent file that Observer does not own", () => {
    const path = join(
      process.env["COPILOT_HOME"]!,
      "plugins",
      "observer",
      "agents",
      "observer-malik-johnson.agent.md",
    )
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, "---\nname: observer-malik-johnson\n---\nUser-owned agent.\n")

    const result = syncCopilotSeatAgents(seats())

    expect(readFileSync(path, "utf8")).toContain("User-owned agent.")
    expect(result.written).toEqual([])
    expect(result.notes.join(" ")).toContain("is not owned by Observer")
    expect(existsSync(copilotSettingsPath())).toBe(false)
  })

  it("removes only Observer-owned settings and files when control is disabled", () => {
    syncCopilotSeatAgents(seats())
    const settings = JSON.parse(readFileSync(copilotSettingsPath(), "utf8"))
    settings.subagents.agents["my-agent"] = { model: "gpt-5.4" }
    writeFileSync(copilotSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`)

    const result = syncCopilotSeatAgents(seats(false))
    const after = JSON.parse(readFileSync(copilotSettingsPath(), "utf8"))
    expect(after.subagents.agents["observer:observer-malik-johnson"]).toBeUndefined()
    expect(after.subagents.agents["my-agent"]).toEqual({ model: "gpt-5.4" })
    expect(result.removed).toHaveLength(1)
    expect(JSON.parse(readFileSync(copilotSeatStatePath(), "utf8")).agents).toEqual([])
  })

  it("does not overwrite malformed settings", () => {
    mkdirSync(join(home, "copilot"), { recursive: true })
    writeFileSync(copilotSettingsPath(), "{ not json")
    const before = readFileSync(copilotSettingsPath(), "utf8")

    const result = syncCopilotSeatAgents(seats())
    expect(readFileSync(copilotSettingsPath(), "utf8")).toBe(before)
    expect(result.notes.join(" ")).toContain("not valid JSON")
  })

  it("does not generate control artifacts before the plugin exists", () => {
    rmSync(join(process.env["COPILOT_HOME"]!, "plugins", "observer"), { recursive: true, force: true })
    const result = syncCopilotSeatAgents(seats())
    expect(result.written).toEqual([])
    expect(result.notes.join(" ")).toContain("Install the Copilot plugin")
  })
})

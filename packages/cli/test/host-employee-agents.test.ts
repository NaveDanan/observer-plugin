import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ROSTER } from "@observer-ai/roster"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  removeClaudeEmployeeAgents,
  removeCodexEmployeeAgents,
  syncClaudeEmployeeAgents,
  syncCodexEmployeeAgents,
} from "../dist/index.js"

let home: string
let originalHome: string | undefined
let originalCodexHome: string | undefined
let originalObserverHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer-host-employees-"))
  originalHome = process.env["HOME"]
  originalCodexHome = process.env["CODEX_HOME"]
  originalObserverHome = process.env["OBSERVER_HOME"]
  process.env["HOME"] = home
  process.env["CODEX_HOME"] = join(home, "codex")
  process.env["OBSERVER_HOME"] = join(home, "observer")
})

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"]
  else process.env["HOME"] = originalHome
  if (originalCodexHome === undefined) delete process.env["CODEX_HOME"]
  else process.env["CODEX_HOME"] = originalCodexHome
  if (originalObserverHome === undefined) delete process.env["OBSERVER_HOME"]
  else process.env["OBSERVER_HOME"] = originalObserverHome
  rmSync(home, { recursive: true, force: true })
})

function seats(control: boolean) {
  return {
    control,
    employees: {
      "arjun-mehta": {
        targets: {
          "codex:default": {
            host: "codex",
            model: "gpt-5.6-sol",
            options: [
              { id: "reasoningEffort", value: "xhigh" },
              { id: "serviceTier", value: "priority" },
            ],
          },
          "claude:default": {
            host: "claude",
            model: "opus",
            options: [{ id: "effort", value: "high" }],
          },
        },
      },
    },
  } as any
}

describe("native employee agents", () => {
  it("makes the full roster available to Codex without model pins by default", () => {
    const result = syncCodexEmployeeAgents({ control: false, employees: {} }, { skillInventory: { skills: [], warnings: [] } })
    const directory = join(process.env["CODEX_HOME"]!, "agents")
    expect(readdirSync(directory)).toHaveLength(ROSTER.length)
    expect(result.written).toHaveLength(ROSTER.length)

    const arjun = readFileSync(join(directory, "observer-arjun-mehta.toml"), "utf8")
    expect(arjun).toContain('name = "observer-arjun-mehta"')
    expect(arjun).toContain("developer_instructions =")
    expect(arjun).not.toMatch(/^model =/m)
  })

  it("pins only the configured Codex employee when control is on", () => {
    syncCodexEmployeeAgents(seats(true), { skillInventory: { skills: [], warnings: [] } })
    const directory = join(process.env["CODEX_HOME"]!, "agents")
    const arjun = readFileSync(join(directory, "observer-arjun-mehta.toml"), "utf8")
    const malik = readFileSync(join(directory, "observer-malik-johnson.toml"), "utf8")

    expect(arjun).toContain('model = "gpt-5.6-sol"')
    expect(arjun).toContain('model_reasoning_effort = "xhigh"')
    expect(arjun).toContain('service_tier = "priority"')
    expect(malik).not.toMatch(/^model =/m)
  })

  it("pins Claude model and effort without forcing the employee", () => {
    const result = syncClaudeEmployeeAgents(seats(true))
    const directory = join(home, ".claude", "agents")
    expect(readdirSync(directory)).toHaveLength(ROSTER.length)

    const arjun = readFileSync(join(directory, "observer-arjun-mehta.md"), "utf8")
    const malik = readFileSync(join(directory, "observer-malik-johnson.md"), "utf8")
    expect(arjun).toContain('model: "opus"')
    expect(arjun).toContain('effort: "high"')
    expect(arjun).toContain("Use proactively")
    expect(arjun).toContain("Same-level peers communicate directly with agent_send")
    expect(malik).not.toMatch(/^model:/m)
    expect(result.notes.join(" ")).toContain("model pins do not force")
  })

  it("removes pins but keeps employee definitions when control turns off", () => {
    syncCodexEmployeeAgents(seats(true), { skillInventory: { skills: [], warnings: [] } })
    const result = syncCodexEmployeeAgents(seats(false), { skillInventory: { skills: [], warnings: [] } })
    const path = join(process.env["CODEX_HOME"]!, "agents", "observer-arjun-mehta.toml")
    expect(readFileSync(path, "utf8")).not.toMatch(/^model =/m)
    expect(result.removed).toEqual([])
    expect(result.written).toEqual([path])
  })

  it("preserves collisions and uninstalls only Observer-owned definitions", () => {
    const codexDirectory = join(process.env["CODEX_HOME"]!, "agents")
    mkdirSync(codexDirectory, { recursive: true })
    const collision = join(codexDirectory, "observer-arjun-mehta.toml")
    writeFileSync(collision, 'name = "mine"\n')

    const result = syncCodexEmployeeAgents(seats(true), { skillInventory: { skills: [], warnings: [] } })
    expect(readFileSync(collision, "utf8")).toBe('name = "mine"\n')
    expect(result.notes.join(" ")).toContain("does not own it")
    expect(removeCodexEmployeeAgents()).toHaveLength(ROSTER.length - 1)
    expect(existsSync(collision)).toBe(true)

    syncClaudeEmployeeAgents(seats(false))
    expect(removeClaudeEmployeeAgents()).toHaveLength(ROSTER.length)
  })

  it("puts project and global skills in every employee's Default pack", () => {
    const skillInventory = {
      skills: [
        { name: "global-review", description: "Review the change", path: "C:\\Users\\me\\.codex\\skills\\review\\SKILL.md", scope: "user" },
        { name: "project-release", description: "Release this project", path: "D:\\repo\\.agents\\skills\\release\\SKILL.md", scope: "repo" },
      ],
      warnings: [],
    }

    const result = syncCodexEmployeeAgents({ control: false, employees: {} }, { skillInventory })
    const directory = join(process.env["CODEX_HOME"]!, "agents")
    for (const employee of readdirSync(directory)) {
      const contents = readFileSync(join(directory, employee), "utf8")
      expect(contents).toContain("## Default skills pack")
      expect(contents).toContain("global-review [user]: Review the change")
      expect(contents).toContain("project-release [repo]: Release this project")
      expect(contents).toContain(".agents\\\\skills\\\\release\\\\SKILL.md")
    }
    expect(result.notes.join(" ")).toContain("Default skill pack gives 2 enabled Codex skills to every employee")
  })

  it("leaves the Default pack out when Pass All Skills is off", () => {
    const result = syncCodexEmployeeAgents(
      { control: false, employees: {} },
      {
        passAllSkills: false,
        skillInventory: {
          skills: [{ name: "review", description: "Review code", path: "/review/SKILL.md", scope: "user" }],
          warnings: [],
        },
      },
    )
    const contents = readFileSync(join(process.env["CODEX_HOME"]!, "agents", "observer-arjun-mehta.toml"), "utf8")
    expect(contents).not.toContain("## Default skills pack")
    expect(result.notes.join(" ")).toContain("Default skill pack is off")
  })
})

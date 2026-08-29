import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { fetchHostSkills } from "../../src/adapters/host-skills.js"
import type { CodexSpawnResult } from "../../src/adapters/codex.js"

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture(): { cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "observer-host-skills-"))
  temporary.push(root)
  const cwd = join(root, "repo")
  const home = join(root, "home")
  mkdirSync(join(cwd, ".git"), { recursive: true })
  mkdirSync(home, { recursive: true })
  return { cwd, home }
}

function skill(path: string, name: string, description = `${name} description`): void {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`)
}

function codexResponse(cwd: string): CodexSpawnResult {
  return {
    stdout: `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        data: [{
          cwd,
          skills: [{
            name: "shared-review",
            description: "Review code",
            path: join(cwd, ".agents", "skills", "shared-review", "SKILL.md"),
            scope: "repo",
            enabled: true,
          }],
          errors: [],
        }],
      },
    })}\n`,
    status: 0,
  }
}

describe("cross-host skill discovery", () => {
  it("merges the authoritative inventories and Claude filesystem roots by skill name", () => {
    const { cwd, home } = fixture()
    skill(join(cwd, ".claude", "skills", "shared-review"), "shared-review", "Review code")
    const inventory = fetchHostSkills({
      cwd,
      homeDir: () => home,
      env: {},
      codex: { spawn: () => codexResponse(cwd) },
      run: (binary) => binary === "opencode"
        ? {
            stdout: JSON.stringify([
              { name: "shared-review", description: "Review code", location: join(cwd, ".claude", "skills", "shared-review", "SKILL.md") },
              { name: "opencode-only", description: "OpenCode only", location: "<built-in>" },
            ]),
            status: 0,
          }
        : {
            stdout: JSON.stringify({
              plugins: [
                { kind: "skill", name: "shared-review", description: "Review code", scope: "repository", source: "project-agents", enabled: true },
                { kind: "skill", name: "disabled", description: "Hidden", scope: "user", source: "personal", enabled: false },
              ],
              errors: [],
            }),
            status: 0,
          },
    })

    expect(inventory.skills.find((entry) => entry.name === "shared-review")?.hosts).toEqual([
      "opencode",
      "codex",
      "claude",
      "copilot",
    ])
    expect(inventory.skills.map((entry) => entry.name)).toContain("opencode-only")
    expect(inventory.skills.map((entry) => entry.name)).not.toContain("disabled")
    expect(inventory.summaries.map((entry) => [entry.host, entry.discovery])).toEqual([
      ["opencode", "native"],
      ["codex", "native"],
      ["claude", "filesystem"],
      ["copilot", "native"],
    ])
  })

  it("falls back to documented OpenCode and Copilot roots without hiding Claude or Codex", () => {
    const { cwd, home } = fixture()
    skill(join(cwd, ".agents", "skills", "shared"), "shared")
    skill(join(home, ".copilot", "skills", "copilot-personal"), "copilot-personal")
    skill(join(home, ".claude", "skills", "claude-personal"), "claude-personal")

    const inventory = fetchHostSkills({
      cwd,
      homeDir: () => home,
      env: {},
      codex: { spawn: () => ({ stdout: "", status: null, timedOut: true }) },
      run: () => ({ stdout: "", status: 1 }),
    })

    expect(inventory.skills.find((entry) => entry.name === "shared")?.hosts).toEqual(["opencode", "codex", "copilot"])
    expect(inventory.skills.find((entry) => entry.name === "claude-personal")?.hosts).toEqual(["opencode", "claude"])
    expect(inventory.skills.find((entry) => entry.name === "copilot-personal")?.hosts).toEqual(["copilot"])
    expect(inventory.summaries.find((entry) => entry.host === "opencode")?.discovery).toBe("filesystem")
    expect(inventory.summaries.find((entry) => entry.host === "codex")?.discovery).toBe("filesystem")
    expect(inventory.summaries.find((entry) => entry.host === "copilot")?.discovery).toBe("filesystem")
    expect(inventory.warnings.join(" ")).toContain("filesystem roots as a fallback")
  })

  it("honours Claude skillOverrides that hide skills from model invocation", () => {
    const { cwd, home } = fixture()
    skill(join(home, ".claude", "skills", "visible"), "visible")
    skill(join(home, ".claude", "skills", "hidden"), "hidden")
    mkdirSync(join(home, ".claude"), { recursive: true })
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      skillOverrides: { hidden: "user-invocable-only" },
    }))

    const inventory = fetchHostSkills({
      cwd,
      homeDir: () => home,
      env: {},
      codex: { spawn: () => codexResponse(cwd) },
      run: () => ({ stdout: "[]", status: 0 }),
    })

    const claude = (name: string): boolean => inventory.skills.find((entry) => entry.name === name)?.hosts.includes("claude") === true
    expect(claude("visible")).toBe(true)
    expect(claude("hidden")).toBe(false)
  })

  it("follows Claude skill junctions and installed plugin roots", () => {
    const { cwd, home } = fixture()
    const shared = join(home, ".agents", "skills", "linked")
    skill(shared, "linked")
    const claudeSkills = join(home, ".claude", "skills")
    mkdirSync(claudeSkills, { recursive: true })
    symlinkSync(shared, join(claudeSkills, "linked"), "junction")

    const plugin = join(home, ".claude", "plugins", "cache", "market", "tool", "1.0.0")
    skill(join(plugin, "skills", "plugin-skill"), "plugin-skill")
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true })
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
      "tool@market": [{ installPath: plugin }],
    }))

    const inventory = fetchHostSkills({
      cwd,
      homeDir: () => home,
      env: {},
      codex: { spawn: () => codexResponse(cwd) },
      run: () => ({ stdout: "[]", status: 0 }),
    })

    const claudeNames = inventory.skills
      .filter((entry) => entry.hosts.includes("claude"))
      .map((entry) => entry.name)
    expect(claudeNames).toContain("linked")
    expect(claudeNames).toContain("plugin-skill")
  })
})

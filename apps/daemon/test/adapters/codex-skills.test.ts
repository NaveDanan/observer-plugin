import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { fetchCodexSkills } from "../../src/adapters/codex-skills.js"
import type { CodexSpawn, CodexSpawnResult } from "../../src/adapters/codex.js"

function response(result: unknown): CodexSpawnResult {
  return {
    stdout: [
      "Codex banner noise",
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, result }),
      "",
    ].join("\n"),
    status: 0,
  }
}

describe("Codex skill discovery", () => {
  it("asks Codex to merge project and global skills for the project cwd", () => {
    const calls: Parameters<CodexSpawn>[] = []
    const cwd = join("work", "observer")
    const spawn: CodexSpawn = (binary, args, options) => {
      calls.push([binary, args, options])
      return response({
        data: [{
          cwd,
          skills: [
            { name: "global-review", description: "Review changes", path: "/home/me/.codex/skills/review/SKILL.md", scope: "user", enabled: true },
            { name: "project-release", description: "Ship this repo", path: `${cwd}/.agents/skills/release/SKILL.md`, scope: "repo", enabled: true },
            { name: "disabled", description: "Not available", path: "/disabled/SKILL.md", scope: "user", enabled: false },
          ],
          errors: [],
        }],
      })
    }

    const result = fetchCodexSkills({ cwd, spawn, env: {}, homeDir: () => "/home/me" })

    expect(result.skills.map((skill) => [skill.name, skill.scope])).toEqual([
      ["global-review", "user"],
      ["project-release", "repo"],
    ])
    expect(calls).toHaveLength(1)
    const [binary, args, options] = calls[0]!
    expect(binary).toBe("codex")
    expect(args).toEqual(["app-server"])
    expect(options.input).toContain('"method":"skills/list"')
    expect(options.input).toContain('"forceReload":true')
    expect(options.env["CODEX_HOME"]).toBe(resolve("/home/me", ".codex"))
  })

  it("fails open when Codex cannot list skills", () => {
    const result = fetchCodexSkills({
      spawn: () => ({ stdout: "", status: null, timedOut: true }),
      timeoutMs: 25,
    })

    expect(result.skills).toEqual([])
    expect(result.warnings.join(" ")).toContain("25 ms")
  })

  it("keeps valid skills when one skill has a load error", () => {
    const result = fetchCodexSkills({
      spawn: () => response({
        data: [{
          cwd: process.cwd(),
          skills: [{ name: "good", description: "Works", path: "/good/SKILL.md", scope: "repo", enabled: true }],
          errors: [{ path: "/bad/SKILL.md", message: "invalid frontmatter" }],
        }],
      }),
    })

    expect(result.skills.map((skill) => skill.name)).toEqual(["good"])
    expect(result.warnings).toEqual(["Codex could not load skill /bad/SKILL.md: invalid frontmatter"])
  })
})

import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { codexHookOutput } from "../dist/codex-control-core.js"

describe("Codex spawn context control", () => {
  it.each(["spawn_agent", "Agent", "collaboration.spawn_agent"])(
    "isolates %s subagents from the root transcript",
    (toolName) => {
    const toolInput = {
      task_name: "security-review",
      message: "Review the authentication flow.",
      fork_turns: "all",
      future_field: { keep: true },
    }

    expect(
      codexHookOutput("PreToolUse", {
        tool_name: toolName,
        tool_input: toolInput,
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...toolInput, fork_turns: "none" },
      },
    })
    },
  )

  it("does not answer hooks or tools it does not control", () => {
    expect(codexHookOutput("PostToolUse", { tool_name: "spawn_agent", tool_input: {} })).toBeUndefined()
    expect(codexHookOutput("PreToolUse", { tool_name: "apply_patch", tool_input: {} })).toBeUndefined()
  })

  it.each([
    ["employee agent", "observer-arjun-mehta"],
    ["subcontractor", "worker"],
  ])("passes the same project and global skills to an %s spawn", (_label, agentType) => {
    const output = codexHookOutput(
      "PreToolUse",
      {
        tool_name: "spawn_agent",
        tool_input: { agent_type: agentType, message: "Review the UI." },
      },
      {
        passAllSkills: true,
        skills: [
          { name: "project-ui", description: "Review this UI", path: "/repo/.agents/skills/ui/SKILL.md", scope: "repo" },
          { name: "global-review", description: "Review code", path: "/home/me/.codex/skills/review/SKILL.md", scope: "user" },
        ],
      },
    )
    const updated = (output?.["hookSpecificOutput"] as Record<string, unknown>)["updatedInput"] as Record<string, unknown>
    expect(updated["message"]).toContain("Review the UI.")
    expect(updated["message"]).toContain("project-ui [repo]")
    expect(updated["message"]).toContain("global-review [user]")
    expect(updated["fork_turns"]).toBe("none")
  })

  it("honours the Pass All Skills opt-out", () => {
    const input = { message: "Review the UI." }
    const output = codexHookOutput(
      "PreToolUse",
      { tool_name: "spawn_agent", tool_input: input },
      { passAllSkills: false, skills: [{ name: "ui", description: "UI", path: "/ui/SKILL.md", scope: "repo" }] },
    )
    expect((output?.["hookSpecificOutput"] as any)["updatedInput"]).toEqual({ ...input, fork_turns: "none" })
  })

  it("emits one Codex decision from the standalone control process", () => {
    const observerHome = mkdtempSync(join(tmpdir(), "observer-codex-control-empty-"))
    try {
      const child = spawnSync(process.execPath, [join(process.cwd(), "packages", "hook-emitter", "dist", "codex-control.js")], {
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_input: { task_name: "review", message: "Review the API." },
        }),
        env: { ...process.env, OBSERVER_HOME: observerHome },
        encoding: "utf8",
      })
      expect(child.status).toBe(0)
      expect(JSON.parse(child.stdout)).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "allow",
          updatedInput: { task_name: "review", message: "Review the API.", fork_turns: "none" },
        },
      })
    } finally {
      rmSync(observerHome, { recursive: true, force: true })
    }
  })

  it("fails open without stdout for malformed input", () => {
    const child = spawnSync(process.execPath, [join(process.cwd(), "packages", "hook-emitter", "dist", "codex-control.js")], {
      input: "{not-json",
      encoding: "utf8",
    })
    expect(child.status).toBe(0)
    expect(child.stdout).toBe("")
  })

  it("loads the cached inventory for the hook payload's project", () => {
    const observerHome = mkdtempSync(join(tmpdir(), "observer-codex-skills-"))
    const cwd = join(observerHome, "project")
    mkdirSync(cwd)
    writeFileSync(join(observerHome, "config.json"), JSON.stringify({ passAllSkills: true }))
    writeFileSync(join(observerHome, "codex-skills.json"), JSON.stringify({
      version: 1,
      projects: [{
        cwd,
        skills: [{ name: "release", description: "Ship it", path: join(cwd, ".agents", "skills", "release", "SKILL.md"), scope: "repo" }],
      }],
    }))
    try {
      const child = spawnSync(process.execPath, [join(process.cwd(), "packages", "hook-emitter", "dist", "codex-control.js")], {
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "spawn_agent",
          tool_input: { message: "Prepare the release." },
        }),
        env: { ...process.env, OBSERVER_HOME: observerHome },
        encoding: "utf8",
      })
      expect(child.status).toBe(0)
      expect(JSON.parse(child.stdout).hookSpecificOutput.updatedInput.message).toContain("release [repo]")
    } finally {
      rmSync(observerHome, { recursive: true, force: true })
    }
  })
})

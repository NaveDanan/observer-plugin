import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { controlCopilotDelegation } from "../dist/copilot-control-core.js"
import type { CopilotControlConfig } from "../dist/copilot-control-core.js"

const configured: CopilotControlConfig = {
  seats: {
    control: true,
    employees: {
      "malik-johnson": {
        targets: {
          "copilot:default": {
            host: "copilot",
            model: "claude-opus-5",
            options: [{ id: "effortLevel", value: "high" }],
          },
        },
      },
    },
  },
}

describe("Copilot delegation control", () => {
  it.each([
    ["object", (args: Record<string, unknown>) => args],
    ["JSON string", (args: Record<string, unknown>) => JSON.stringify(args)],
  ])("rewrites only agent_type and preserves the complete neutral task payload from a %s", (_label, wrap) => {
    const args = {
      agent_type: "general-purpose",
      name: "api-helper",
      description: "Review API scaling",
      prompt: "Scale the database and redesign the API contracts.",
      mode: "background",
      model: "inherit",
      reasoning_effort: "medium",
      context_tier: "default",
      futureField: { keep: true },
    }

    expect(
      controlCopilotDelegation({ toolName: "task", toolArgs: wrap(args) }, configured, () => true),
    ).toEqual({
      modifiedArgs: {
        ...args,
        agent_type: "observer:observer-malik-johnson",
      },
    })
  })

  it("emits one valid decision object and exits zero", () => {
    const home = mkdtempSync(join(tmpdir(), "observer-copilot-control-"))
    try {
      const observerHome = join(home, "observer")
      const copilotHome = join(home, "copilot")
      mkdirSync(observerHome, { recursive: true })
      mkdirSync(join(copilotHome, "plugins", "observer", "agents"), { recursive: true })
      writeFileSync(join(observerHome, "config.json"), `${JSON.stringify(configured)}\n`)
      writeFileSync(
        join(copilotHome, "plugins", "observer", "agents", "observer-malik-johnson.agent.md"),
        "---\n# observer:copilot-seat-agent v1\nmodel: claude-opus-5\n---\n",
      )
      writeFileSync(
        join(copilotHome, "settings.json"),
        `${JSON.stringify({
          subagents: {
            agents: {
              "observer:observer-malik-johnson": {
                model: "claude-opus-5",
                effortLevel: "high",
              },
            },
          },
        })}\n`,
      )

      const input = JSON.stringify({
        toolName: "task",
        toolArgs: JSON.stringify({
          agent_type: "general-purpose",
          name: "api-helper",
          prompt: "Scale the database and redesign the API contracts.",
        }),
      })
      const run = () =>
        spawnSync(
          process.execPath,
          [join(process.cwd(), "packages", "hook-emitter", "dist", "copilot-control.js")],
          {
            input,
            encoding: "utf8",
            env: { ...process.env, OBSERVER_HOME: observerHome, COPILOT_HOME: copilotHome },
          },
        )

      const child = run()
      expect(child.status).toBe(0)
      expect(JSON.parse(child.stdout)).toEqual({
        modifiedArgs: {
          agent_type: "observer:observer-malik-johnson",
          name: "api-helper",
          prompt: "Scale the database and redesign the API contracts.",
        },
      })

      writeFileSync(join(copilotHome, "settings.json"), "{}\n")
      expect(JSON.parse(run().stdout)).toEqual({})
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("emits an empty decision and exits zero for malformed input", () => {
    const child = spawnSync(
      process.execPath,
      [join(process.cwd(), "packages", "hook-emitter", "dist", "copilot-control.js")],
      {
        input: "{not-json",
        encoding: "utf8",
      },
    )
    expect(child.status).toBe(0)
    expect(child.stdout).toBe("{}")
  })

  it("does not replace specialised agents", () => {
    expect(
      controlCopilotDelegation(
        {
          toolName: "task",
          toolArgs: {
            agent_type: "security-review",
            prompt: "Review the API authentication and database authorization.",
          },
        },
        configured,
        () => true,
      ),
    ).toBeUndefined()
  })

  it("fails open when control, target, input, matching, or generated agent evidence is missing", () => {
    const neutral = {
      toolName: "task",
      toolArgs: {
        agent_type: "general-purpose",
        prompt: "Scale the database and redesign the API contracts.",
      },
    }

    expect(controlCopilotDelegation(neutral, { ...configured, seats: { ...configured.seats, control: false } }, () => true)).toBeUndefined()
    expect(
      controlCopilotDelegation(
        neutral,
        { ...configured, seats: { control: true, employees: { "malik-johnson": {} } } },
        () => true,
      ),
    ).toBeUndefined()
    expect(controlCopilotDelegation({ toolName: "task", toolArgs: "not-an-object" }, configured, () => true)).toBeUndefined()
    expect(controlCopilotDelegation({ toolName: "task", toolArgs: "{not-json" }, configured, () => true)).toBeUndefined()
    expect(
      controlCopilotDelegation(
        { toolName: "task", toolArgs: { agent_type: "general-purpose", prompt: "hello" } },
        configured,
        () => true,
      ),
    ).toBeUndefined()
    expect(controlCopilotDelegation(neutral, configured, () => false)).toBeUndefined()
  })

  it("does not control another tool", () => {
    const args = {
      agent_type: "general-purpose",
      prompt: "Scale the database and redesign the API contracts.",
    }
    expect(controlCopilotDelegation({ toolName: "bash", toolArgs: args }, configured, () => true)).toBeUndefined()
  })
})

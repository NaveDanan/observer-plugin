import { join } from "node:path"
import { describe, expect, it } from "vitest"
// Straight from source, not the package barrel: `apps/daemon` resolves to
// `dist`, and `src/adapters/index.ts` is ticket 02's file. Importing the built
// copy would test whatever was last compiled.
import {
  CLAUDE_CAPABILITIES,
  CLAUDE_DEFAULT_BINARY,
  CLAUDE_DEFAULT_PROFILE_ID,
  CLAUDE_MODEL_GATES,
  CLAUDE_OPTION_IDS,
  PROMPT_ONLY_EFFORTS,
  claudeConfigDir,
  compareClaudeVersions,
  createClaudeAdapter,
  diagnoseClaudeTarget,
  hostEffortValue,
  parseClaudeVersion,
} from "../../src/adapters/claude.js"
import type { ClaudeVersionRunner } from "../../src/adapters/claude.js"
import type { ProviderInstanceConfig } from "../../src/providers.js"
import type { SeatIssueCode, SeatTarget } from "../../src/seats.js"

/**
 * Every spawn in these tests is fake. Nothing here executes `claude`, opens a
 * config directory, or reads a credential — which is also the property the
 * adapter itself is built to have, so the fake is a fair stand-in rather than
 * a convenience.
 */
interface FakeRun {
  runner: ClaudeVersionRunner
  /** One entry per spawn: what was run and the env it would have been given. */
  calls: Array<{ binary: string; env: NodeJS.ProcessEnv }>
}

/** A `claude --version` that prints `version`, or fails when it is undefined. */
function fakeRun(version: string | undefined): FakeRun {
  const calls: Array<{ binary: string; env: NodeJS.ProcessEnv }> = []
  const runner: ClaudeVersionRunner = (binary, env) => {
    calls.push({ binary, env })
    // `undefined` is the adapter's contract for every failure mode at once:
    // ENOENT, non-zero exit, and timeout all land here.
    return version === undefined ? undefined : `${version} (Claude Code)`
  }
  return { runner, calls }
}

const ENV: NodeJS.ProcessEnv = { HOME: "/home/real", PATH: "/usr/bin" }

function adapterAt(version: string | undefined, extra: Parameters<typeof createClaudeAdapter>[0] = {}) {
  const run = fakeRun(version)
  const adapter = createClaudeAdapter({ env: ENV, home: "/home/real", runVersion: run.runner, ...extra })
  return { adapter, run }
}

function modelIds(version: string | undefined): string[] {
  const { adapter } = adapterAt(version)
  return adapter.catalogue(CLAUDE_DEFAULT_PROFILE_ID).models.map((model) => model.id)
}

function optionIds(version: string | undefined, modelId: string): string[] {
  const { adapter } = adapterAt(version)
  const model = adapter.catalogue(CLAUDE_DEFAULT_PROFILE_ID).models.find((entry) => entry.id === modelId)
  return (model?.options ?? []).map((option) => option.id)
}

function codes(issues: ReturnType<typeof diagnoseClaudeTarget>): SeatIssueCode[] {
  return issues.map((issue) => issue.code)
}

function diagnose(target: SeatTarget, version = "2.4.0") {
  const { adapter } = adapterAt(version)
  return adapter.diagnose(CLAUDE_DEFAULT_PROFILE_ID, "claude:default", target, "arjun-mehta")
}

describe("version parsing", () => {
  it("takes the first x.y.z out of a decorated line", () => {
    expect(parseClaudeVersion("2.4.1 (Claude Code)")).toBe("2.4.1")
    expect(parseClaudeVersion("  1.0.86 (Claude Code)\n")).toBe("1.0.86")
    // A pre-release gates as its release: the gate is a feature gate, and a
    // beta of 2.4.0 has 2.4.0's models.
    expect(parseClaudeVersion("2.4.0-beta.3")).toBe("2.4.0")
  })

  it("answers undefined rather than guessing", () => {
    expect(parseClaudeVersion(undefined)).toBeUndefined()
    expect(parseClaudeVersion("")).toBeUndefined()
    expect(parseClaudeVersion("command not found: claude")).toBeUndefined()
    // Two components is not a version this can gate on.
    expect(parseClaudeVersion("2.4")).toBeUndefined()
  })

  it("compares numerically, not lexically", () => {
    expect(compareClaudeVersions("2.10.0", "2.9.0")).toBe(1)
    expect(compareClaudeVersions("1.0.0", "1.0.0")).toBe(0)
    expect(compareClaudeVersions("1.9.0", "2.0.0")).toBe(-1)
    expect(compareClaudeVersions("2", "2.0.0")).toBe(0)
  })
})

describe("profiles", () => {
  it("uses CLAUDE_CONFIG_DIR when it is set", () => {
    const { adapter } = adapterAt("2.4.0", { env: { ...ENV, CLAUDE_CONFIG_DIR: "/work/.claude" } })
    expect(adapter.profiles()[0]?.homePath).toBe("/work/.claude")
  })

  it("falls back to ~/.claude", () => {
    const { adapter } = adapterAt("2.4.0")
    expect(adapter.profiles()).toEqual([
      {
        id: CLAUDE_DEFAULT_PROFILE_ID,
        host: "claude",
        label: "Claude Code",
        binaryPath: CLAUDE_DEFAULT_BINARY,
        homePath: join("/home/real", ".claude"),
      },
    ])
  })

  it("reports one profile per configured claude instance, skipping disabled ones", () => {
    const providers: Record<string, ProviderInstanceConfig> = {
      "claude:work": { driver: "claude", enabled: true, homePath: "/work/.claude", binaryPath: "/opt/claude" },
      "claude:personal": { driver: "claude", enabled: true, displayName: "Personal Claude" },
      "claude:old": { driver: "claude", enabled: false },
      "codex:default": { driver: "codex", enabled: true },
    }
    const { adapter } = adapterAt("2.4.0", { providers })
    expect(adapter.profiles().map((profile) => profile.id)).toEqual(["claude:work", "claude:personal"])
    expect(adapter.profiles()[0]).toMatchObject({ binaryPath: "/opt/claude", homePath: "/work/.claude" })
    // An instance with no `homePath` still falls back, so two profiles are
    // never silently pointed at nothing.
    expect(adapter.profiles()[1]).toMatchObject({ label: "Personal Claude", homePath: join("/home/real", ".claude") })
  })
})

/**
 * The credential rules, asserted rather than commented.
 *
 * These are the tests that would catch the regression that matters: a probe
 * that relocates keychain lookup, or one that grows an argument that makes
 * Claude Code initialise an account.
 */
describe("credential safety", () => {
  it("never overrides HOME in the probe environment", () => {
    const { adapter, run } = adapterAt("2.4.0", { env: { ...ENV, CLAUDE_CONFIG_DIR: "/work/.claude" } })
    adapter.catalogue(CLAUDE_DEFAULT_PROFILE_ID)
    expect(run.calls).toHaveLength(1)
    // The exact bug this guards: pointing HOME at a profile directory sends
    // macOS keychain resolution somewhere that has no keychain, and the user
    // is told to re-authenticate a profile that was authenticated all along.
    expect(run.calls[0]?.env["HOME"]).toBe("/home/real")
    // The config dir is the only isolation knob, and it is set.
    expect(run.calls[0]?.env["CLAUDE_CONFIG_DIR"]).toBe("/work/.claude")
  })

  it("probes once per profile however often the catalogue is read", () => {
    const { adapter, run } = adapterAt("2.4.0")
    for (let index = 0; index < 5; index += 1) adapter.catalogue(CLAUDE_DEFAULT_PROFILE_ID)
    // A seat editor calls this on every keystroke. One touch of the user's
    // install, not one per character.
    expect(run.calls).toHaveLength(1)
  })

  it("runs the configured binary and nothing else", () => {
    const providers: Record<string, ProviderInstanceConfig> = {
      "claude:work": { driver: "claude", enabled: true, binaryPath: "/opt/claude" },
    }
    const { adapter, run } = adapterAt("2.4.0", { providers })
    adapter.catalogue("claude:work")
    expect(run.calls[0]?.binary).toBe("/opt/claude")
  })
})

describe("catalogue", () => {
  it("survives a missing binary and still offers models", () => {
    const { adapter } = adapterAt(undefined)
    const catalogue = adapter.catalogue(CLAUDE_DEFAULT_PROFILE_ID)
    expect(catalogue.freshness).toBe("cached")
    // Ungated rather than empty: hiding a model the user has installed loses
    // its descriptors with no explanation, while offering one they do not have
    // costs a single self-explaining rejection.
    expect(catalogue.models.length).toBe(CLAUDE_MODEL_GATES.length)
    expect(catalogue.warnings.join(" ")).toContain("not gated")
    expect(catalogue.source).toContain("no version")
  })

  it("warns instead of throwing on a profile that does not exist", () => {
    const { adapter } = adapterAt("2.4.0")
    const catalogue = adapter.catalogue("claude:nope")
    expect(catalogue.warnings.join(" ")).toContain("claude:nope")
    expect(catalogue.freshness).toBe("cached")
  })

  it("gates models in and out on the reported version", () => {
    // 1.0.0: the launch models and their aliases, no Haiku line, no 4.8, no 5.
    expect(modelIds("1.0.0")).toEqual(["opus", "sonnet", "claude-opus-4-5", "claude-sonnet-4-5"])

    // 1.6.0 adds the Haiku line.
    expect(modelIds("1.6.0")).toContain("haiku")
    expect(modelIds("1.6.0")).toContain("claude-haiku-4-5")
    expect(modelIds("1.6.0")).not.toContain("claude-opus-4-8")

    // 2.0.0 adds Opus 4.8 but not Opus 5.
    expect(modelIds("2.0.0")).toContain("claude-opus-4-8")
    expect(modelIds("2.0.0")).not.toContain("claude-opus-5")

    // 2.4.0 has everything.
    expect(modelIds("2.4.0")).toEqual(CLAUDE_MODEL_GATES.map((gate) => gate.id))
  })

  it("appends custom model strings with no descriptors", () => {
    const { adapter } = adapterAt("2.4.0", {
      customModels: ["anthropic.claude-opus-4-5-v1:0", "  ", "opus"],
    })
    const models = adapter.catalogue(CLAUDE_DEFAULT_PROFILE_ID).models
    const custom = models.find((model) => model.id === "anthropic.claude-opus-4-5-v1:0")
    expect(custom).toEqual({ id: "anthropic.claude-opus-4-5-v1:0", label: "anthropic.claude-opus-4-5-v1:0", options: [] })
    // Appended, not interleaved.
    expect(models[models.length - 1]?.id).toBe("anthropic.claude-opus-4-5-v1:0")
    // Blanks dropped, and a custom id that duplicates a built-in does not
    // shadow the built-in's descriptors.
    expect(models.filter((model) => model.id === "opus")).toHaveLength(1)
    expect(models.find((model) => model.id === "opus")?.options.length).toBeGreaterThan(0)
  })

  it("takes per-profile custom models off the provider instance", () => {
    const providers: Record<string, ProviderInstanceConfig> = {
      "claude:work": {
        driver: "claude",
        enabled: true,
        models: ["projects/p/locations/l/publishers/anthropic/models/claude-opus-4-5"],
      } as ProviderInstanceConfig,
    }
    const { adapter } = adapterAt("2.4.0", { providers })
    expect(adapter.catalogue("claude:work").models.map((model) => model.id)).toContain(
      "projects/p/locations/l/publishers/anthropic/models/claude-opus-4-5",
    )
  })
})

describe("model options are independent descriptors", () => {
  it("only emits ids from the declared set", () => {
    const { adapter } = adapterAt("2.4.0")
    for (const model of adapter.catalogue(CLAUDE_DEFAULT_PROFILE_ID).models) {
      for (const option of model.options) {
        expect(CLAUDE_OPTION_IDS).toContain(option.id)
      }
    }
  })

  it("gives Opus an effort scale and no thinking toggle", () => {
    expect(optionIds("2.4.0", "claude-opus-5")).toEqual(["effort", "contextWindow", "fastMode"])
    expect(optionIds("2.4.0", "claude-opus-5")).not.toContain("thinking")
  })

  it("gives Haiku a thinking toggle and no effort scale", () => {
    // The whole reason descriptors are per model: a shared option list would
    // put an effort slider on Haiku and a thinking switch on Opus, and both
    // would do nothing.
    expect(optionIds("2.4.0", "claude-haiku-4-5")).toEqual(["fastMode", "thinking"])
    expect(optionIds("2.4.0", "claude-haiku-4-5")).not.toContain("effort")
  })

  it("does not offer a context selection to a model that has none", () => {
    // A select with one choice is a control that cannot change anything.
    expect(optionIds("2.4.0", "claude-opus-4-5")).toEqual(["effort"])
  })

  it("gates capabilities separately from the model itself", () => {
    // Opus 4.8 exists at 2.0.0 with xhigh and the 1M selection, but fast mode
    // arrives at 2.2.0 — a single per-model `since` would have to hide one or
    // offer the other too early.
    expect(optionIds("2.0.0", "claude-opus-4-8")).toEqual(["effort", "contextWindow"])
    expect(optionIds("2.2.0", "claude-opus-4-8")).toEqual(["effort", "contextWindow", "fastMode"])
  })

  it("adds xhigh only where and when the CLI accepts it", () => {
    const efforts = (version: string, id: string): string[] => {
      const { adapter } = adapterAt(version)
      const model = adapter.catalogue(CLAUDE_DEFAULT_PROFILE_ID).models.find((entry) => entry.id === id)
      return (model?.options.find((option) => option.id === "effort")?.choices ?? []).map((choice) => choice.id)
    }
    expect(efforts("1.9.0", "sonnet")).toEqual(["low", "medium", "high"])
    expect(efforts("2.0.0", "opus")).toEqual(["low", "medium", "high", "xhigh"])
    // Shipped before xhigh existed and never gained it.
    expect(efforts("2.4.0", "claude-opus-4-5")).toEqual(["low", "medium", "high"])
  })

  it("marks medium as the default level", () => {
    const { adapter } = adapterAt("2.4.0")
    const effort = adapter
      .catalogue(CLAUDE_DEFAULT_PROFILE_ID)
      .models.find((model) => model.id === "opus")
      ?.options.find((option) => option.id === "effort")
    expect(effort?.choices?.filter((choice) => choice.isDefault).map((choice) => choice.id)).toEqual(["medium"])
  })
})

/**
 * `ultrathink` is prompt text. Claude has no request field that accepts it, so
 * sending it as `effort` is at best a rejected call and at worst a silently
 * ignored setting that leaves the user paying for reasoning they did not get.
 */
describe("ultrathink is never an effort value", () => {
  it("never appears as a choice on any model at any version", () => {
    for (const version of [undefined, "1.0.0", "1.6.0", "1.9.0", "2.0.0", "2.2.0", "2.4.0", "9.9.9"]) {
      const { adapter } = adapterAt(version)
      for (const model of adapter.catalogue(CLAUDE_DEFAULT_PROFILE_ID).models) {
        for (const option of model.options) {
          for (const choice of option.choices ?? []) {
            expect(PROMPT_ONLY_EFFORTS.has(choice.id)).toBe(false)
            expect(choice.id).not.toBe("ultrathink")
          }
        }
      }
    }
  })

  it("is filtered at the send site too", () => {
    // Second defence: a value that arrives from a hand-edited config never
    // reaches a host as an effort, whatever the picker did.
    expect(hostEffortValue("ultrathink")).toBeUndefined()
    expect(hostEffortValue("  UltraThink ")).toBeUndefined()
    expect(hostEffortValue("high")).toBe("high")
    expect(hostEffortValue(" high ")).toBe("high")
    // Undefined means "omit the field", never "send an empty effort".
    expect(hostEffortValue("")).toBeUndefined()
    expect(hostEffortValue(true)).toBeUndefined()
    expect(hostEffortValue(undefined)).toBeUndefined()
  })

  it("is reported as prompt text rather than as a typo", () => {
    const issues = diagnose({ host: "claude", model: "opus", options: [{ id: "effort", value: "ultrathink" }] })
    expect(codes(issues)).toEqual(["unrecognised-variant"])
    // Told only "unrecognised", a user concludes they misspelled a level and
    // sets it again. The sentence has to name the actual problem.
    expect(issues[0]?.message).toContain("prompt text")
    expect(issues[0]?.message).toContain("will not send it")
  })
})

describe("diagnose", () => {
  it("accepts an alias, a full id and a provider deployment id", () => {
    for (const model of [
      "opus",
      "sonnet",
      "claude-opus-4-5",
      "anthropic.claude-opus-4-5-v1:0",
      "projects/p/locations/l/publishers/anthropic/models/claude-opus-4-5",
    ]) {
      expect(diagnose({ host: "claude", model })).toEqual([])
    }
  })

  it("never requires provider/model", () => {
    // OpenCode's addressing scheme, applied to Claude, turns every correct
    // alias into a config-blocking error.
    expect(diagnose({ host: "claude", model: "opus" })).toEqual([])
    expect(codes(diagnose({ host: "claude", model: "claude-opus-5" }))).not.toContain("malformed-model")
  })

  it("rejects only an empty model", () => {
    expect(codes(diagnose({ host: "claude", model: "" }))).toEqual(["malformed-model"])
    expect(codes(diagnose({ host: "claude", model: "   " }))).toEqual(["malformed-model"])
    expect(diagnose({ host: "claude", model: "" })[0]?.severity).toBe("error")
    // An omitted model is not an error: it means "inherit the session's".
    expect(diagnose({ host: "claude" })).toEqual([])
  })

  it("warns when an option is set that the model does not declare", () => {
    const issues = diagnose({
      host: "claude",
      model: "claude-opus-4-5",
      options: [{ id: "thinking", value: true }],
    })
    expect(codes(issues)).toEqual(["unknown-field"])
    expect(issues[0]?.severity).toBe("warning")
    expect(issues[0]?.message).toContain("does not offer")
    expect(issues[0]?.path).toBe("seats.employees.arjun-mehta.targets.claude:default.options.thinking")
  })

  it("stays silent about options on a model it does not know", () => {
    // A deployment id's capabilities are unknowable from here, so "this model
    // does not declare thinking" would be an assertion with no basis.
    expect(
      diagnose({
        host: "claude",
        model: "anthropic.claude-opus-4-5-v1:0",
        options: [{ id: "thinking", value: true }, { id: "effort", value: "turbo" }],
      }),
    ).toEqual([])
  })

  it("reports an option id it does not apply as info, preserved not deleted", () => {
    const issues = diagnose({ host: "claude", model: "opus", options: [{ id: "sandbox", value: "danger" }] })
    expect(codes(issues)).toEqual(["unknown-field"])
    expect(issues[0]?.severity).toBe("info")
    expect(issues[0]?.message).toContain("preserved in the file")
  })

  it("warns on an effort the model does not offer, without blocking it", () => {
    const issues = diagnose({ host: "claude", model: "claude-opus-4-5", options: [{ id: "effort", value: "xhigh" }] })
    expect(codes(issues)).toEqual(["unrecognised-variant"])
    expect(issues[0]?.severity).toBe("warning")
    expect(issues[0]?.message).toContain("final say")
  })

  it("warns on a switch where a level belongs", () => {
    const issues = diagnose({ host: "claude", model: "opus", options: [{ id: "effort", value: true }] })
    expect(codes(issues)).toEqual(["unrecognised-variant"])
    expect(issues[0]?.message).toContain("named level")
  })

  it("leaves options-without-model to host-agnostic diagnosis", () => {
    // `diagnoseSeats` already raises it. Repeating it here doubles the finding
    // in any UI that merges both sources.
    expect(diagnose({ host: "claude", options: [{ id: "effort", value: "high" }] })).toEqual([])
  })

  it("survives shapes the schema would never produce", () => {
    expect(diagnose({ host: "claude", model: "opus", options: "nope" } as unknown as SeatTarget)).toEqual([])
    expect(diagnose({ host: "claude", model: 5 } as unknown as SeatTarget)).toEqual([])
    expect(diagnoseClaudeTarget({ target: { host: "claude" }, targetId: "t", employeeId: "e", models: [] })).toEqual([])
  })

  it("scopes every finding to the employee, target and host", () => {
    const issues = diagnose({ host: "claude", model: "" })
    expect(issues[0]).toMatchObject({ employeeId: "arjun-mehta", targetId: "claude:default", host: "claude" })
  })
})

describe("capabilities", () => {
  it("does not claim child control it has not verified", () => {
    const { adapter } = adapterAt("2.4.0")
    expect(adapter.capabilities(CLAUDE_DEFAULT_PROFILE_ID)).toEqual({
      discovery: "cached",
      // Claude's agent-definition contract really does carry a per-subagent
      // model and effort. Observer has no verified path to set it, and a seat
      // UI reads these flags to tell a user their employee "runs Opus" — which
      // is a claim about their bill.
      childModel: "unsupported",
      childReasoning: "unsupported",
      requiresReload: true,
    })
  })

  it("hands back a copy, so a caller cannot mutate the shared constant", () => {
    const { adapter } = adapterAt("2.4.0")
    const capabilities = adapter.capabilities(CLAUDE_DEFAULT_PROFILE_ID)
    capabilities.childModel = "supported"
    expect(CLAUDE_CAPABILITIES.childModel).toBe("unsupported")
  })

  it("reports discovery as cached, because that is what it is", () => {
    // Not "live": the list came off disk in this repository. A live SDK
    // inventory would run credential-sensitive initialisation on a user who
    // only opened a config screen.
    const { adapter } = adapterAt("2.4.0")
    expect(adapter.catalogue(CLAUDE_DEFAULT_PROFILE_ID).freshness).toBe("cached")
    expect(adapter.capabilities(CLAUDE_DEFAULT_PROFILE_ID).discovery).toBe("cached")
  })
})

describe("config directory resolution", () => {
  it("prefers CLAUDE_CONFIG_DIR, then ~/.claude", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/work/.claude" }, "/home/real")).toBe("/work/.claude")
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "" }, "/home/real")).toBe(join("/home/real", ".claude"))
    expect(claudeConfigDir({}, "/home/real")).toBe(join("/home/real", ".claude"))
  })
})

describe("adapter identity", () => {
  it("claims the claude host", () => {
    const { adapter } = adapterAt("2.4.0")
    expect(adapter.kind).toBe("claude")
    expect(adapter.label).toBe("Claude Code")
  })
})

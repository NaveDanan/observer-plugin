import { describe, expect, it } from "vitest"
import {
  COPILOT_CONTEXT_TIER_OPTION,
  COPILOT_DEFAULT_PROFILE,
  COPILOT_REASONING_OPTION,
  copilotAdapter,
  createCopilotAdapter,
  helpDeclaresAutoModel,
  parseCopilotChoices,
  parseCopilotModelIds,
} from "../../src/adapters/copilot.js"
import type { CopilotSpawn, CopilotSpawnResult } from "../../src/adapters/copilot.js"
import type { SeatTarget } from "../../src/seats.js"

/**
 * Everything here runs against a fake `copilot`.
 *
 * Not one test launches a real binary, and that is a security property rather
 * than a style preference: a real Copilot CLI is authenticated to GitHub, and a
 * test suite that shells out to it is a test suite that can be made to spend
 * credits, mutate session state or trip an update on whoever runs it. The fake
 * is the same narrow seam the adapter takes in production, so a test that
 * passes here exercises the real parsing, budgeting and containment code —
 * only the process is faked.
 *
 * The fixtures below are trimmed transcripts of GitHub Copilot CLI 1.0.80,
 * captured 2026-08-23, wrapped at the same 80 columns commander uses when its
 * stdout is a pipe.
 */

interface Call {
  binary: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
}

/** A scripted host: a result per argv, and a hard failure for anything else. */
function fakeSpawn(script: Record<string, CopilotSpawnResult>): { spawn: CopilotSpawn; calls: Call[] } {
  const calls: Call[] = []
  const spawn: CopilotSpawn = (binary, args, options) => {
    calls.push({ binary, args, ...options })
    return script[args.join(" ")] ?? { stdout: "", status: 1 }
  }
  return { spawn, calls }
}

const HELP_CONFIG = `Configuration Settings:

  \`logLevel\`: log level for CLI; defaults to "default". Set to "all" for debug logging.

  \`model\`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.
    - "claude-opus-5"
    - "claude-sonnet-4.5"
    - "gpt-5.6-sol"
    - "gemini-3.7-flash"

  \`contextTier\`: context window tier for tiered-pricing models (e.g., "default" or "long_context").
    - Can also be set with --context flag (overrides persisted setting)

  \`subagents.agents.<agent-name>\`: per-subagent model, effortLevel, and contextTier selection.
    - Each field can be set to "inherit" to use the parent session's effective value
`

const HELP_ROOT = `Usage: copilot [options] [command]

GitHub Copilot CLI - An AI-powered coding assistant.

Options:
  --context <tier>                      Set the context window tier (overrides
                                        persisted setting) (choices: "default",
                                        "long_context")
  --effort, --reasoning-effort <level>  Set the reasoning effort level (choices:
                                        "none", "minimal", "low", "medium",
                                        "high", "xhigh", "max")
  --mode <mode>                         Set the initial agent mode (choices:
                                        "interactive", "plan", "autopilot")
  --model <model>                       Set the AI model to use (use 'auto' to
                                        let Copilot pick automatically)
  -v, --version                         show version information
`

function ok(stdout: string): CopilotSpawnResult {
  return { stdout, status: 0 }
}

const HEALTHY: Record<string, CopilotSpawnResult> = {
  "help config": ok(HELP_CONFIG),
  "--help": ok(HELP_ROOT),
}

function adapterWith(
  script: Record<string, CopilotSpawnResult>,
  overrides: Parameters<typeof createCopilotAdapter>[0] = {},
) {
  const { spawn, calls } = fakeSpawn(script)
  const adapter = createCopilotAdapter({
    spawn,
    env: {},
    homeDir: () => "/home/tester",
    now: () => 1_000,
    ...overrides,
  })
  return { adapter, calls }
}

function target(partial: Partial<SeatTarget>): SeatTarget {
  return { host: "copilot", ...partial }
}

/* -------------------------------------------------------------------------- */

describe("copilot adapter profiles", () => {
  it("resolves the default home under the user's home directory", () => {
    const { adapter, calls } = adapterWith(HEALTHY)
    expect(adapter.profiles()).toEqual([
      {
        id: COPILOT_DEFAULT_PROFILE,
        host: "copilot",
        label: "GitHub Copilot CLI",
        binaryPath: "copilot",
        homePath: "/home/tester/.copilot",
      },
    ])
    // Discovery is not a probe. Listing profiles must cost nothing — this is
    // the directory the GitHub token lives in, and Observer does not go near it
    // to answer a question it can answer with string concatenation.
    expect(calls).toHaveLength(0)
  })

  it("prefers COPILOT_HOME and says so in the label", () => {
    const { adapter } = adapterWith(HEALTHY, { env: { COPILOT_HOME: "  /srv/work-copilot  " } })
    const profile = adapter.profiles()[0]
    expect(profile?.homePath).toBe("/srv/work-copilot")
    expect(profile?.label).toBe("GitHub Copilot CLI (/srv/work-copilot)")
  })

  it("reports the configured binary", () => {
    const { adapter } = adapterWith(HEALTHY, { binaryPath: "/opt/copilot/bin/copilot" })
    expect(adapter.profiles()[0]?.binaryPath).toBe("/opt/copilot/bin/copilot")
  })
})

/* -------------------------------------------------------------------------- */

describe("copilot adapter catalogue", () => {
  it("lists the models the installed CLI documents, each with the global effort ladder", () => {
    const { adapter } = adapterWith(HEALTHY)
    const catalogue = adapter.catalogue(COPILOT_DEFAULT_PROFILE)

    expect(catalogue.freshness).toBe("live")
    expect(catalogue.warnings).toEqual([])
    // `auto` leads, because this build's `--help` declared it.
    expect(catalogue.models.map((model) => model.id)).toEqual([
      "auto",
      "claude-opus-5",
      "claude-sonnet-4.5",
      "gpt-5.6-sol",
      "gemini-3.7-flash",
    ])
    expect(catalogue.models[0]?.label).toBe("Auto (Copilot picks)")

    const effort = catalogue.models[1]?.options[0]
    expect(effort).toMatchObject({ id: COPILOT_REASONING_OPTION, label: "Reasoning effort", type: "select" })
    expect(effort?.choices?.map((choice) => choice.id)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    // Copilot never says which rung it stands on by default, so nothing is
    // marked as one.
    expect(effort?.choices?.some((choice) => choice.isDefault === true)).toBe(false)
    expect(effort?.currentValue).toBeUndefined()
  })

  it("never offers a contextTier control, because Copilot will not say which models are tiered", () => {
    const { adapter } = adapterWith(HEALTHY)
    for (const model of adapter.catalogue(COPILOT_DEFAULT_PROFILE).models) {
      expect(model.options.map((option) => option.id)).not.toContain(COPILOT_CONTEXT_TIER_OPTION)
    }
  })

  it("invents no context window, since Copilot publishes none per model", () => {
    const { adapter } = adapterWith(HEALTHY)
    for (const model of adapter.catalogue(COPILOT_DEFAULT_PROFILE).models) {
      expect(model.contextWindow).toBeUndefined()
    }
  })

  it("omits `auto` when this build's help does not declare it", () => {
    const { adapter } = adapterWith({
      "help config": ok(HELP_CONFIG),
      "--help": ok(HELP_ROOT.replace("(use 'auto' to\n                                        let Copilot pick automatically)", "Set it")),
    })
    expect(adapter.catalogue(COPILOT_DEFAULT_PROFILE).models.map((model) => model.id)).not.toContain("auto")
  })

  it("probes with COPILOT_HOME pinned, auto-update off and colour off", () => {
    const { adapter, calls } = adapterWith(HEALTHY, { env: { PATH: "/usr/bin", HOME: "/home/tester" } })
    adapter.catalogue(COPILOT_DEFAULT_PROFILE)

    expect(calls.map((call) => call.args.join(" "))).toEqual(["help config", "--help"])
    for (const call of calls) {
      expect(call.env["COPILOT_HOME"]).toBe("/home/tester/.copilot")
      // A config-screen keystroke must never be able to upgrade the user's
      // toolchain in the background.
      expect(call.env["COPILOT_AUTO_UPDATE"]).toBe("false")
      // ANSI escapes would silently defeat the parse on a working install.
      expect(call.env["NO_COLOR"]).toBe("1")
      // HOME is inherited untouched: overriding it is what makes an
      // authenticated CLI report itself logged out.
      expect(call.env["HOME"]).toBe("/home/tester")
      expect(call.env["PATH"]).toBe("/usr/bin")
    }
  })

  it("never invokes a subcommand that could authenticate, prompt or spend", () => {
    const { adapter, calls } = adapterWith(HEALTHY)
    adapter.catalogue(COPILOT_DEFAULT_PROFILE)
    const argv = calls.map((call) => call.args.join(" ")).join(" | ")
    for (const forbidden of ["login", "-p", "--prompt", "-i", "--acp", "--resume", "--continue", "update"]) {
      expect(argv).not.toContain(forbidden)
    }
  })

  it("returns an empty catalogue and a typing instruction when the binary is missing", () => {
    const { adapter } = adapterWith({ "help config": { stdout: "", status: null, failure: "was not found on PATH" } })
    const catalogue = adapter.catalogue(COPILOT_DEFAULT_PROFILE)

    expect(catalogue.models).toEqual([])
    // Not "live": we did not learn that this Copilot has no models, we failed
    // to learn anything.
    expect(catalogue.freshness).toBe("unknown")
    expect(catalogue.warnings[0]).toContain("was not found on PATH")
    expect(catalogue.warnings[0]).toContain("Install GitHub Copilot CLI")
  })

  it("does not spawn the second probe once the first has failed", () => {
    const { adapter, calls } = adapterWith({ "help config": { stdout: "", status: 1 } })
    adapter.catalogue(COPILOT_DEFAULT_PROFILE)
    expect(calls.map((call) => call.args.join(" "))).toEqual(["help config"])
  })

  it("survives a launcher that throws instead of reporting", () => {
    const adapter = createCopilotAdapter({
      env: {},
      homeDir: () => "/home/tester",
      now: () => 1_000,
      spawn: () => {
        throw new Error("posix_spawn refused")
      },
    })
    const catalogue = adapter.catalogue(COPILOT_DEFAULT_PROFILE)
    expect(catalogue.models).toEqual([])
    expect(catalogue.warnings.join(" ")).toContain("posix_spawn refused")
  })

  it("reports a timeout as a timeout, naming the budget", () => {
    const { adapter } = adapterWith(
      { "help config": { stdout: "", status: null, timedOut: true } },
      { timeoutMs: 2_000 },
    )
    expect(adapter.catalogue(COPILOT_DEFAULT_PROFILE).warnings[0]).toContain("within 2000 ms")
  })

  it("still lists models when only the option probe fails", () => {
    const { adapter } = adapterWith({ "help config": ok(HELP_CONFIG), "--help": { stdout: "", status: 1 } })
    const catalogue = adapter.catalogue(COPILOT_DEFAULT_PROFILE)

    // A model list with no effort control beats no list at all.
    expect(catalogue.models.map((model) => model.id)).toEqual([
      "claude-opus-5",
      "claude-sonnet-4.5",
      "gpt-5.6-sol",
      "gemini-3.7-flash",
    ])
    expect(catalogue.models.every((model) => model.options.length === 0)).toBe(true)
    expect(catalogue.warnings.join(" ")).toContain("no reasoning-effort levels are offered")
  })

  it("warns that a model must be typed by hand when the help topic lists none", () => {
    const { adapter } = adapterWith({ "help config": ok("Configuration Settings:\n\n  `theme`: colours.\n") })
    const catalogue = adapter.catalogue(COPILOT_DEFAULT_PROFILE)

    expect(catalogue.models).toEqual([])
    expect(catalogue.warnings.join(" ")).toContain("Type a model id by hand")
  })

  it("refuses to list models for a profile it does not have", () => {
    const { adapter, calls } = adapterWith(HEALTHY)
    const catalogue = adapter.catalogue("copilot:someone-elses")
    expect(catalogue.models).toEqual([])
    expect(catalogue.warnings[0]).toContain('no Copilot profile called "copilot:someone-elses"')
    expect(calls).toHaveLength(0)
  })

  it("memoises a success, and says `cached` rather than `live` when it does", () => {
    let clock = 1_000
    const { adapter, calls } = adapterWith(HEALTHY, { now: () => clock })

    expect(adapter.catalogue(COPILOT_DEFAULT_PROFILE).freshness).toBe("live")
    clock += 60_000
    const second = adapter.catalogue(COPILOT_DEFAULT_PROFILE)
    expect(second.freshness).toBe("cached")
    expect(second.models).toHaveLength(5)
    expect(calls).toHaveLength(2)

    // Ten minutes on, a `copilot update` should be noticed.
    clock += 10 * 60_000
    expect(adapter.catalogue(COPILOT_DEFAULT_PROFILE).freshness).toBe("live")
    expect(calls).toHaveLength(4)
  })

  it("remembers a failure for far less time than a success", () => {
    let clock = 1_000
    const { adapter, calls } = adapterWith({ "help config": { stdout: "", status: 1 } }, { now: () => clock })

    adapter.catalogue(COPILOT_DEFAULT_PROFILE)
    clock += 10_000
    adapter.catalogue(COPILOT_DEFAULT_PROFILE)
    expect(calls).toHaveLength(1)

    clock += 25_000
    adapter.catalogue(COPILOT_DEFAULT_PROFILE)
    expect(calls).toHaveLength(2)
  })

  it("keys the cache on the home, so two accounts never share an inventory", () => {
    const { spawn, calls } = fakeSpawn(HEALTHY)
    const work = createCopilotAdapter({ spawn, env: { COPILOT_HOME: "/srv/work" }, now: () => 1_000 })
    const personal = createCopilotAdapter({ spawn, env: {}, homeDir: () => "/home/tester", now: () => 1_000 })

    work.catalogue(COPILOT_DEFAULT_PROFILE)
    personal.catalogue(COPILOT_DEFAULT_PROFILE)
    expect(calls.map((call) => call.env["COPILOT_HOME"])).toEqual([
      "/srv/work",
      "/srv/work",
      "/home/tester/.copilot",
      "/home/tester/.copilot",
    ])
  })
})

/* -------------------------------------------------------------------------- */

describe("copilot adapter capabilities", () => {
  it("reports child model and reasoning as unsupported", () => {
    // Copilot really does have `subagents.agents.<name>.{model,effortLevel}`.
    // This flag is a statement about Observer's verified path to it, which does
    // not exist: the setting is persistent config in the same directory as the
    // GitHub token, not a per-delegation parameter, and the parent never places
    // the call. A seat UI reads these flags to decide whether to tell a user
    // their employee "runs Opus", and that sentence is a claim about their bill.
    const { adapter } = adapterWith(HEALTHY)
    expect(adapter.capabilities(COPILOT_DEFAULT_PROFILE)).toEqual({
      discovery: "live",
      childModel: "unsupported",
      childReasoning: "unsupported",
      requiresReload: true,
    })
  })

  it("degrades discovery to manual once a probe has come back empty", () => {
    const { adapter, calls } = adapterWith({ "help config": { stdout: "", status: 1 } })
    expect(adapter.capabilities(COPILOT_DEFAULT_PROFILE).discovery).toBe("live")

    adapter.catalogue(COPILOT_DEFAULT_PROFILE)
    expect(adapter.capabilities(COPILOT_DEFAULT_PROFILE).discovery).toBe("manual")
    // Reading a capability must never cost a subprocess of its own.
    expect(calls).toHaveLength(1)
  })

  it("declares itself a copilot adapter", () => {
    const { adapter } = adapterWith(HEALTHY)
    expect(adapter.kind).toBe("copilot")
    expect(adapter.label).toBe("GitHub Copilot CLI")
  })
})

/* -------------------------------------------------------------------------- */

describe("copilot adapter diagnosis", () => {
  function diagnose(t: SeatTarget, script = HEALTHY, warm = true) {
    const { adapter } = adapterWith(script)
    if (warm) adapter.catalogue(COPILOT_DEFAULT_PROFILE)
    return adapter.diagnose(COPILOT_DEFAULT_PROFILE, "copilot:default", t, "nia-okafor")
  }

  it("says nothing about a well-formed target", () => {
    expect(
      diagnose(target({ model: "claude-opus-5", options: [{ id: COPILOT_REASONING_OPTION, value: "xhigh" }] })),
    ).toEqual([])
  })

  it("accepts `auto` as a model", () => {
    expect(diagnose(target({ model: "auto" }))).toEqual([])
  })

  it("does not impose OpenCode's provider/model shape on a bare Copilot slug", () => {
    // `gpt-5.6-sol` is correct as written. Rejecting it would fail
    // `SeatDiagnosis.ok` — and therefore block a write — on a working config.
    expect(diagnose(target({ model: "gpt-5.6-sol" }))).toEqual([])
  })

  it("rejects an empty model, and only an empty model", () => {
    const issues = diagnose(target({ model: "   " }))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      code: "malformed-model",
      severity: "error",
      path: "seats.employees.nia-okafor.targets.copilot:default.model",
      employeeId: "nia-okafor",
      targetId: "copilot:default",
      host: "copilot",
    })
  })

  it("says nothing when the model is simply absent", () => {
    expect(diagnose(target({}))).toEqual([])
  })

  it("warns, never errors, on an effort this install does not advertise", () => {
    const issues = diagnose(
      target({ model: "claude-opus-5", options: [{ id: COPILOT_REASONING_OPTION, value: "ludicrous" }] }),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.severity).toBe("warning")
    expect(issues[0]?.code).toBe("unrecognised-variant")
    expect(issues[0]?.message).toContain("none, minimal, low, medium, high, xhigh, max")
  })

  it("stays silent about an effort when nothing has been probed yet", () => {
    // A config keystroke must not cost a subprocess, so diagnosis reads the
    // cache and never probes. With no ladder there is no authority to warn from.
    expect(
      diagnose(
        target({ model: "claude-opus-5", options: [{ id: COPILOT_REASONING_OPTION, value: "ludicrous" }] }),
        HEALTHY,
        false,
      ),
    ).toEqual([])
  })

  it("warns when an effort arrives as a switch", () => {
    const issues = diagnose(
      target({ model: "claude-opus-5", options: [{ id: COPILOT_REASONING_OPTION, value: true }] }),
    )
    expect(issues[0]?.message).toContain("not a switch")
  })

  it("validates a hand-written contextTier even though no control offers one", () => {
    expect(diagnose(target({ model: "claude-opus-5", options: [{ id: COPILOT_CONTEXT_TIER_OPTION, value: "long_context" }] }))).toEqual([])

    const issues = diagnose(
      target({ model: "claude-opus-5", options: [{ id: COPILOT_CONTEXT_TIER_OPTION, value: "huge" }] }),
    )
    expect(issues[0]?.severity).toBe("warning")
    expect(issues[0]?.message).toContain("long_context")
  })

  it("reports an option it does not apply as info, and promises to preserve it", () => {
    const issues = diagnose(target({ model: "claude-opus-5", options: [{ id: "serviceTier", value: "flex" }] }))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ code: "unknown-field", severity: "info" })
    expect(issues[0]?.message).toContain("preserved in the file untouched")
  })

  it("leaves `options-without-model` to the shared diagnoser", () => {
    expect(diagnose(target({ options: [{ id: COPILOT_REASONING_OPTION, value: "high" }] }))).toEqual([])
  })

  it("returns findings rather than throwing on a hand-mangled target", () => {
    const mangled = { host: "copilot", model: "claude-opus-5", options: "high" } as unknown as SeatTarget
    expect(diagnose(mangled)).toEqual([])
    const nulled = { host: "copilot", model: "claude-opus-5", options: [null, { value: "x" }] } as unknown as SeatTarget
    expect(diagnose(nulled)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */

describe("copilot help parsing", () => {
  it("reads the model bullet list and stops at the next setting", () => {
    expect(parseCopilotModelIds(HELP_CONFIG)).toEqual([
      "claude-opus-5",
      "claude-sonnet-4.5",
      "gpt-5.6-sol",
      "gemini-3.7-flash",
    ])
  })

  it("is not fooled by the word `model` in prose", () => {
    const prose = "Configuration Settings:\n\n  `theme`: the model of colours.\n    - \"github\"\n"
    expect(parseCopilotModelIds(prose)).toEqual([])
  })

  it("survives an absent section, an empty string and a non-string", () => {
    expect(parseCopilotModelIds("")).toEqual([])
    expect(parseCopilotModelIds(undefined)).toEqual([])
    expect(parseCopilotModelIds("nothing here")).toEqual([])
  })

  it("reassembles a choice list wrapped across three lines", () => {
    // Read line by line this would return `none, minimal, low, medium` at 80
    // columns and the full set on a wide terminal — a silent, environment
    // dependent truncation that would then be used to warn a user that `max` is
    // not a real effort.
    expect(parseCopilotChoices(HELP_ROOT, "--effort")).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
  })

  it("does not let one option's choices leak into the next", () => {
    expect(parseCopilotChoices(HELP_ROOT, "--context")).toEqual(["default", "long_context"])
    expect(parseCopilotChoices(HELP_ROOT, "--mode")).toEqual(["interactive", "plan", "autopilot"])
  })

  it("matches a flag exactly, so `--model` is not `--mode`", () => {
    // `--model` declares no choices; returning `--mode`'s would put "plan" in a
    // model picker.
    expect(parseCopilotChoices(HELP_ROOT, "--model")).toEqual([])
  })

  it("returns nothing for a flag this build does not have", () => {
    expect(parseCopilotChoices(HELP_ROOT, "--telepathy")).toEqual([])
    expect(parseCopilotChoices(undefined, "--effort")).toEqual([])
  })

  it("only claims `auto` when the installed help declares it", () => {
    expect(helpDeclaresAutoModel(HELP_ROOT)).toBe(true)
    expect(helpDeclaresAutoModel("Options:\n  --model <model>  Set the AI model to use\n")).toBe(false)
    expect(helpDeclaresAutoModel(undefined)).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */

describe("the default copilot adapter", () => {
  it("constructs without touching a process, a file or the network", () => {
    // Importing an adapter registry must not cost a subprocess per host, and
    // must certainly not read anything out of a credential directory. If this
    // module shelled out at import, this file would have done it already.
    expect(copilotAdapter.kind).toBe("copilot")
    expect(copilotAdapter.profiles()).toHaveLength(1)
    expect(copilotAdapter.capabilities(COPILOT_DEFAULT_PROFILE).childModel).toBe("unsupported")
  })
})

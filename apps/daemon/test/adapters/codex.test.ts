import { describe, expect, it } from "vitest"
import { CODEX_DEFAULT_PROFILE, codexAdapter, createCodexAdapter, readModel } from "../../src/adapters/codex.js"
import type { CodexSpawn, CodexSpawnResult } from "../../src/adapters/codex.js"
import type { SeatTarget } from "../../src/seats.js"

/**
 * Everything here runs against a fake `codex`.
 *
 * Not one test launches a real binary: the interesting half of this adapter is
 * what it does when the host is missing, hung, old or lying, and none of those
 * are reproducible against an install. The fake is the same narrow seam the
 * adapter takes in production, so a test that passes here is exercising the
 * real parsing, pagination and containment code — only the process is faked.
 */

interface Call {
  binary: string
  args: readonly string[]
  input: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
}

/** A scripted host: one queued result per page, then a hard failure. */
function fakeSpawn(results: CodexSpawnResult[]): { spawn: CodexSpawn; calls: Call[] } {
  const calls: Call[] = []
  const queue = [...results]
  const spawn: CodexSpawn = (binary, args, options) => {
    calls.push({ binary, args, ...options })
    return queue.shift() ?? { stdout: "", status: 1 }
  }
  return { spawn, calls }
}

function rpc(id: number, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`
}

function ok(payload: unknown): CodexSpawnResult {
  // A real app-server answers the handshake first and may print a banner; both
  // are included so the reader is tested against noise, not a clean stream.
  return {
    stdout: `Codex app-server 1.4.0\n${rpc(1, { protocolVersion: "1" })}${rpc(2, payload)}`,
    status: 0,
  }
}

const GPT = {
  id: "gpt-5.6-sol",
  displayName: "GPT-5.6 Sol",
  contextWindow: 400_000,
  supportedReasoningEfforts: ["low", "medium", "high", "ultra-max"],
  defaultReasoningEffort: "medium",
  supportedServiceTiers: ["flex", "priority"],
  defaultServiceTier: "flex",
}

function adapterWith(results: CodexSpawnResult[], overrides: Parameters<typeof createCodexAdapter>[0] = {}) {
  const { spawn, calls } = fakeSpawn(results)
  const adapter = createCodexAdapter({
    spawn,
    env: {},
    homeDir: () => "/home/tester",
    now: () => 1_000,
    ...overrides,
  })
  return { adapter, calls }
}

describe("codex adapter profiles", () => {
  it("resolves the default home under the user's home directory", () => {
    const { adapter, calls } = adapterWith([])
    expect(adapter.profiles()).toEqual([
      {
        id: CODEX_DEFAULT_PROFILE,
        host: "codex",
        label: "Codex",
        binaryPath: "codex",
        homePath: "/home/tester/.codex",
      },
    ])
    // Discovery is not a probe. Listing profiles must cost nothing.
    expect(calls).toHaveLength(0)
  })

  it("prefers CODEX_HOME and says so in the label", () => {
    const { adapter } = adapterWith([], { env: { CODEX_HOME: "  /srv/work-codex  " } })
    const profile = adapter.profiles()[0]
    expect(profile?.homePath).toBe("/srv/work-codex")
    expect(profile?.label).toBe("Codex (/srv/work-codex)")
  })

  it("reports the configured binary", () => {
    const { adapter } = adapterWith([], { binaryPath: "/opt/codex/bin/codex" })
    expect(adapter.profiles()[0]?.binaryPath).toBe("/opt/codex/bin/codex")
  })
})

describe("codex adapter catalogue", () => {
  it("maps efforts and tiers into two separate descriptors", () => {
    const { adapter } = adapterWith([ok({ items: [GPT] })])
    const catalogue = adapter.catalogue(CODEX_DEFAULT_PROFILE)

    expect(catalogue.freshness).toBe("live")
    expect(catalogue.warnings).toEqual([])
    expect(catalogue.models).toHaveLength(1)
    const model = catalogue.models[0]!
    expect(model.id).toBe("gpt-5.6-sol")
    expect(model.label).toBe("GPT-5.6 Sol")
    expect(model.contextWindow).toBe(400_000)
    expect(model.options.map((option) => option.id)).toEqual(["reasoningEffort", "serviceTier"])

    const effort = model.options[0]!
    expect(effort).toMatchObject({ id: "reasoningEffort", label: "Reasoning effort", type: "select", currentValue: "medium" })
    expect(effort.choices).toEqual([
      { id: "low", label: "low" },
      { id: "medium", label: "medium", isDefault: true },
      { id: "high", label: "high" },
      { id: "ultra-max", label: "ultra-max" },
    ])

    const tier = model.options[1]!
    expect(tier).toMatchObject({ id: "serviceTier", label: "Service tier", type: "select", currentValue: "flex" })
    expect(tier.choices?.map((choice) => choice.id)).toEqual(["flex", "priority"])
  })

  it("preserves an unknown effort string verbatim", () => {
    const { adapter } = adapterWith([
      ok({ items: [{ id: "gpt-6-preview", supportedReasoningEfforts: ["Whatever_Level-9", "τηινκ"] }] }),
    ])
    const choices = adapter.catalogue(CODEX_DEFAULT_PROFILE).models[0]?.options[0]?.choices
    // No lower-casing, no mapping onto SEAT_VARIANTS, no dropping. The host's
    // string is the only one the host will accept back.
    expect(choices?.map((choice) => choice.id)).toEqual(["Whatever_Level-9", "τηινκ"])
  })

  it("keeps a declared default the supported list forgot to include", () => {
    const { adapter } = adapterWith([
      ok({ items: [{ id: "gpt-6", supportedReasoningEfforts: ["low"], defaultReasoningEffort: "auto" }] }),
    ])
    const effort = adapter.catalogue(CODEX_DEFAULT_PROFILE).models[0]?.options[0]
    expect(effort?.choices?.map((choice) => choice.id)).toEqual(["low", "auto"])
    expect(effort?.currentValue).toBe("auto")
  })

  it("omits a descriptor a model advertises no choices for", () => {
    const { adapter } = adapterWith([ok({ items: [{ id: "gpt-6-nano" }] })])
    // An empty select is a control the user can open and cannot use.
    expect(adapter.catalogue(CODEX_DEFAULT_PROFILE).models[0]?.options).toEqual([])
  })

  it("follows the cursor across two pages", () => {
    const { adapter, calls } = adapterWith([
      ok({ items: [GPT, { id: "gpt-6-mini" }], nextCursor: "page-2" }),
      ok({ items: [{ id: "o5-deep" }] }),
    ])
    const catalogue = adapter.catalogue(CODEX_DEFAULT_PROFILE)

    expect(catalogue.models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "gpt-6-mini", "o5-deep"])
    expect(catalogue.freshness).toBe("live")
    expect(catalogue.warnings).toEqual([])
    expect(calls).toHaveLength(2)

    // The handshake is repeated per process, and page two carries the cursor.
    for (const call of calls) {
      expect(call.args).toEqual(["app-server"])
      expect(call.input).toContain('"method":"initialize"')
      expect(call.input).toContain('"method":"initialized"')
      expect(call.input).toContain('"method":"model/list"')
      expect(call.env["CODEX_HOME"]).toBe("/home/tester/.codex")
    }
    expect(calls[0]?.input).not.toContain("cursor")
    expect(calls[1]?.input).toContain('"cursor":"page-2"')
  })

  it("drops a model repeated across pages", () => {
    const { adapter } = adapterWith([ok({ items: [GPT], nextCursor: "p2" }), ok({ items: [GPT] })])
    expect(adapter.catalogue(CODEX_DEFAULT_PROFILE).models.map((model) => model.id)).toEqual(["gpt-5.6-sol"])
  })

  it("stops when the server repeats a cursor, keeping what it has", () => {
    const { adapter, calls } = adapterWith([
      ok({ items: [GPT], nextCursor: "same" }),
      ok({ items: [{ id: "gpt-6-mini" }], nextCursor: "same" }),
    ])
    const catalogue = adapter.catalogue(CODEX_DEFAULT_PROFILE)
    expect(calls).toHaveLength(2)
    expect(catalogue.models).toHaveLength(2)
    expect(catalogue.warnings.join(" ")).toContain("repeated the same model/list cursor")
  })

  it("returns an empty catalogue and a readable warning when the binary is missing", () => {
    const { adapter } = adapterWith([{ stdout: "", status: null, failure: "was not found on PATH" }])
    const catalogue = adapter.catalogue(CODEX_DEFAULT_PROFILE)

    expect(catalogue.models).toEqual([])
    expect(catalogue.freshness).toBe("unknown")
    expect(catalogue.warnings).toHaveLength(1)
    expect(catalogue.warnings[0]).toContain("codex")
    expect(catalogue.warnings[0]).toContain("was not found on PATH")
    expect(catalogue.warnings[0]).toContain("no Codex models are listed")
  })

  it("returns an empty catalogue when the host hangs", () => {
    const { adapter } = adapterWith([{ stdout: "", status: null, timedOut: true }], { timeoutMs: 2_500 })
    const catalogue = adapter.catalogue(CODEX_DEFAULT_PROFILE)

    expect(catalogue.models).toEqual([])
    expect(catalogue.freshness).toBe("unknown")
    expect(catalogue.warnings[0]).toContain("2500 ms")
  })

  it("uses an answer that arrived before the kill", () => {
    // A server that replies and then declines to exit on EOF was killed by the
    // budget. Its answer is still a good answer.
    const { adapter } = adapterWith([{ ...ok({ items: [GPT] }), status: null, timedOut: true }])
    expect(adapter.catalogue(CODEX_DEFAULT_PROFILE).models.map((model) => model.id)).toEqual(["gpt-5.6-sol"])
  })

  it("survives malformed JSON on stdout", () => {
    const { adapter } = adapterWith([{ stdout: '{"jsonrpc":"2.0","id":2,"result":{"items":[\nnot json at all\n', status: 0 }])
    const catalogue = adapter.catalogue(CODEX_DEFAULT_PROFILE)

    expect(catalogue.models).toEqual([])
    expect(catalogue.freshness).toBe("unknown")
    expect(catalogue.warnings[0]).toContain("no readable answer")
  })

  it("survives a result that is not an object", () => {
    const { adapter } = adapterWith([{ stdout: rpc(2, "surprise"), status: 0 }])
    expect(adapter.catalogue(CODEX_DEFAULT_PROFILE).freshness).toBe("unknown")
  })

  it("reports a JSON-RPC error with the server's own message", () => {
    const { adapter } = adapterWith([
      { stdout: `${JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "unknown method" } })}\n`, status: 0 },
    ])
    const catalogue = adapter.catalogue(CODEX_DEFAULT_PROFILE)
    expect(catalogue.models).toEqual([])
    expect(catalogue.warnings[0]).toContain("unknown method")
  })

  it("reports a non-zero exit", () => {
    const { adapter } = adapterWith([{ stdout: "", status: 7 }])
    expect(adapter.catalogue(CODEX_DEFAULT_PROFILE).warnings[0]).toContain("code 7")
  })

  it("ignores a notification carrying a different id", () => {
    const { adapter } = adapterWith([
      { stdout: `${rpc(99, { items: [{ id: "wrong" }] })}${rpc(2, { items: [GPT] })}`, status: 0 },
    ])
    expect(adapter.catalogue(CODEX_DEFAULT_PROFILE).models.map((model) => model.id)).toEqual(["gpt-5.6-sol"])
  })

  it("contains a launcher that throws", () => {
    const adapter = createCodexAdapter({
      env: {},
      homeDir: () => "/home/tester",
      spawn: () => {
        throw new Error("EMFILE: too many open files")
      },
    })
    const catalogue = adapter.catalogue(CODEX_DEFAULT_PROFILE)
    expect(catalogue.models).toEqual([])
    expect(catalogue.warnings[0]).toContain("EMFILE")
  })

  it("rejects an unknown profile without spawning anything", () => {
    const { adapter, calls } = adapterWith([ok({ items: [GPT] })])
    const catalogue = adapter.catalogue("codex:nonexistent")
    expect(catalogue.models).toEqual([])
    expect(catalogue.freshness).toBe("unknown")
    expect(catalogue.warnings[0]).toContain("codex:nonexistent")
    expect(calls).toHaveLength(0)
  })

  it("memoises a successful probe and marks the memo as cached", () => {
    const { adapter, calls } = adapterWith([ok({ items: [GPT] })])
    const first = adapter.catalogue(CODEX_DEFAULT_PROFILE)
    const second = adapter.catalogue(CODEX_DEFAULT_PROFILE)

    expect(calls).toHaveLength(1)
    expect(first.freshness).toBe("live")
    expect(second.freshness).toBe("cached")
    expect(second.models.map((model) => model.id)).toEqual(["gpt-5.6-sol"])
  })

  it("re-probes once a cached success expires", () => {
    let clock = 1_000
    const { adapter, calls } = adapterWith([ok({ items: [GPT] }), ok({ items: [{ id: "gpt-7" }] })], {
      now: () => clock,
    })
    adapter.catalogue(CODEX_DEFAULT_PROFILE)
    clock += 11 * 60_000
    expect(adapter.catalogue(CODEX_DEFAULT_PROFILE).models.map((model) => model.id)).toEqual(["gpt-7"])
    expect(calls).toHaveLength(2)
  })

  it("remembers a failure briefly so a missing binary is not respawned per keystroke", () => {
    let clock = 1_000
    const { adapter, calls } = adapterWith(
      [{ stdout: "", status: null, failure: "was not found on PATH" }, ok({ items: [GPT] })],
      { now: () => clock },
    )
    adapter.catalogue(CODEX_DEFAULT_PROFILE)
    adapter.catalogue(CODEX_DEFAULT_PROFILE)
    expect(calls).toHaveLength(1)

    clock += 31_000
    expect(adapter.catalogue(CODEX_DEFAULT_PROFILE).models).toHaveLength(1)
    expect(calls).toHaveLength(2)
  })

  it("splits the budget across pages and stops when it is spent", () => {
    let clock = 1_000
    const { adapter, calls } = adapterWith(
      [ok({ items: [GPT], nextCursor: "p2" }), ok({ items: [{ id: "gpt-6-mini" }], nextCursor: "p3" })],
      {
        timeoutMs: 3_000,
        now: () => {
          const value = clock
          clock += 2_000
          return value
        },
      },
    )
    const catalogue = adapter.catalogue(CODEX_DEFAULT_PROFILE)
    expect(calls.length).toBeLessThan(3)
    expect(catalogue.warnings.join(" ")).toContain("may be incomplete")
    expect(catalogue.models.length).toBeGreaterThan(0)
  })
})

describe("codex adapter diagnose", () => {
  const target = (overrides: Partial<SeatTarget> = {}): SeatTarget => ({ host: "codex", ...overrides })

  function seated(results: CodexSpawnResult[] = [ok({ items: [GPT] })]) {
    const { adapter } = adapterWith(results)
    adapter.catalogue(CODEX_DEFAULT_PROFILE)
    return adapter
  }

  it("accepts a bare slug", () => {
    const adapter = seated()
    expect(adapter.diagnose(CODEX_DEFAULT_PROFILE, "codex:default", target({ model: "gpt-5.6-sol" }), "malik-johnson")).toEqual([])
  })

  it("accepts a bare slug the probe never listed", () => {
    // Codex ships models faster than Observer ships releases. An unlisted slug
    // is not evidence of a typo.
    const adapter = seated()
    expect(adapter.diagnose(CODEX_DEFAULT_PROFILE, "codex:default", target({ model: "gpt-9-unreleased" }), "malik-johnson")).toEqual([])
  })

  it("rejects only an empty model", () => {
    const adapter = seated()
    const issues = adapter.diagnose(CODEX_DEFAULT_PROFILE, "codex:default", target({ model: "   " }), "malik-johnson")
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      code: "malformed-model",
      severity: "error",
      host: "codex",
      targetId: "codex:default",
      employeeId: "malik-johnson",
      path: "seats.employees.malik-johnson.targets.codex:default.model",
    })
  })

  it("says nothing about a target with no model at all", () => {
    const adapter = seated()
    expect(adapter.diagnose(CODEX_DEFAULT_PROFILE, "codex:default", target(), "malik-johnson")).toEqual([])
  })

  it("warns when an effort is not one the model advertises", () => {
    const adapter = seated()
    const issues = adapter.diagnose(
      CODEX_DEFAULT_PROFILE,
      "codex:default",
      target({ model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "xhigh" }] }),
      "malik-johnson",
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe("unrecognised-variant")
    expect(issues[0]?.severity).toBe("warning")
    expect(issues[0]?.message).toContain("low, medium, high, ultra-max")
    expect(issues[0]?.message).toContain("the host has the final say")
  })

  it("does not warn about an effort the model does advertise, however exotic", () => {
    const adapter = seated()
    expect(
      adapter.diagnose(
        CODEX_DEFAULT_PROFILE,
        "codex:default",
        target({ model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "ultra-max" }] }),
        "malik-johnson",
      ),
    ).toEqual([])
  })

  it("stays silent with no cached catalogue, and never probes", () => {
    const { adapter, calls } = adapterWith([ok({ items: [GPT] })])
    const issues = adapter.diagnose(
      CODEX_DEFAULT_PROFILE,
      "codex:default",
      target({ model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "xhigh" }] }),
      "malik-johnson",
    )
    expect(issues).toEqual([])
    // Diagnosis runs on every keystroke in a config screen. It must never
    // launch a process.
    expect(calls).toHaveLength(0)
  })

  it("ignores options that are not reasoning effort", () => {
    const adapter = seated()
    expect(
      adapter.diagnose(
        CODEX_DEFAULT_PROFILE,
        "codex:default",
        target({ model: "gpt-5.6-sol", options: [{ id: "serviceTier", value: "whatever" }] }),
        "malik-johnson",
      ),
    ).toEqual([])
  })

  it("throws nothing on a garbage target", () => {
    const adapter = seated()
    const junk = { host: "codex", model: 5, options: "not-an-array" } as unknown as SeatTarget
    expect(adapter.diagnose(CODEX_DEFAULT_PROFILE, "codex:default", junk, "malik-johnson")).toEqual([])
  })
})

describe("codex adapter capabilities", () => {
  it("reports live discovery and experimental child control", () => {
    const { adapter } = adapterWith([])
    expect(adapter.capabilities(CODEX_DEFAULT_PROFILE)).toEqual({
      discovery: "live",
      // Not "supported": the protocol carries the fields, but Observer has no
      // tested pre-spawn path that fills them in.
      childModel: "experimental",
      childReasoning: "experimental",
      requiresReload: false,
    })
  })

  it("is a codex adapter", () => {
    const { adapter } = adapterWith([])
    expect(adapter.kind).toBe("codex")
    expect(adapter.label).toBe("Codex")
  })

  it("constructs the shipped adapter without touching the operating system", () => {
    // The registry imports this module. If building the default adapter cost a
    // subprocess, every daemon start would pay one per host — and a machine
    // with no Codex would pay a failed one.
    expect(codexAdapter.kind).toBe("codex")
    expect(codexAdapter.capabilities(CODEX_DEFAULT_PROFILE).discovery).toBe("live")
  })
})

describe("readModel", () => {
  it("skips a record with no usable id", () => {
    expect(readModel({ displayName: "nameless" })).toBeUndefined()
    expect(readModel(null)).toBeUndefined()
    expect(readModel(["gpt-5"])).toBeUndefined()
  })

  it("falls back to the slug for a label", () => {
    expect(readModel({ id: "gpt-6" })).toEqual({ id: "gpt-6", label: "gpt-6", options: [] })
  })

  it("reads object-shaped choices with their own labels and defaults", () => {
    const model = readModel({
      id: "gpt-6",
      supportedReasoningEfforts: [
        { id: "low", label: "Low" },
        { value: "high", displayName: "High", isDefault: true },
      ],
    })
    expect(model?.options[0]?.choices).toEqual([
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
    ])
    expect(model?.options[0]?.currentValue).toBe("high")
  })

  it("ignores a zero or negative context window", () => {
    expect(readModel({ id: "gpt-6", contextWindow: 0 })?.contextWindow).toBeUndefined()
    expect(readModel({ id: "gpt-6", context_window: 128_000 })?.contextWindow).toBe(128_000)
  })
})

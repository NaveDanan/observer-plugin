import { describe, expect, it } from "vitest"
// Straight from source rather than the package barrel: the barrel resolves to
// `dist`, and other adapters are landing in the same directory right now.
// Importing the built copy would silently test whatever was last compiled.
import { OPENCODE_DEFAULT_PROFILE, createOpencodeAdapter, readOpencodeTarget } from "../src/adapters/opencode.js"
import { seatAdapter, seatAdapters } from "../src/adapters/index.js"
import type { ModelInfo } from "../src/models.js"
import { SEAT_VARIANTS } from "../src/seats.js"
import type { SeatTarget } from "../src/seats.js"

/**
 * A catalogue, injected rather than read from disk.
 *
 * `readModels` exists for exactly this: the real source is a 4 MB file under
 * `~/.cache/opencode` and a test that depended on it would be deciding its
 * assertions from whatever the developer running it happens to have installed.
 */
function models(...entries: ModelInfo[]): (options: { include?: string[] }) => ModelInfo[] {
  return () => entries
}

const OPUS: ModelInfo = {
  id: "anthropic/claude-opus-4-5",
  provider: "anthropic",
  providerLabel: "Anthropic",
  label: "Claude Opus 4.5",
  contextWindow: 200_000,
  variants: { kind: "efforts", values: ["low", "medium", "high"] },
  known: true,
}

const HAIKU: ModelInfo = {
  id: "anthropic/claude-haiku-4-5",
  provider: "anthropic",
  providerLabel: "Anthropic",
  label: "Claude Haiku 4.5",
  contextWindow: 200_000,
  variants: { kind: "none" },
  known: true,
}

const SONNET: ModelInfo = {
  id: "anthropic/claude-sonnet-4-5",
  provider: "anthropic",
  providerLabel: "Anthropic",
  label: "Claude Sonnet 4.5",
  variants: { kind: "unknown" },
  known: true,
}

function target(model?: string, variant?: string | boolean): SeatTarget {
  const built: SeatTarget = { host: "opencode" }
  if (model !== undefined) built.model = model
  if (variant !== undefined) built.options = [{ id: "variant", value: variant }]
  return built
}

describe("readOpencodeTarget", () => {
  it("decodes the model and the variant option", () => {
    expect(readOpencodeTarget(target("anthropic/claude-opus-4-5", "high"))).toEqual({
      model: "anthropic/claude-opus-4-5",
      variant: "high",
    })
  })

  it("returns undefined for a target with no model, whatever its options say", () => {
    // A variant with no model is a no-op the host discards. There is nothing to
    // write, which is a different answer from "this is wrong" — that comes back
    // from `diagnose`, with a sentence.
    expect(readOpencodeTarget(target(undefined, "high"))).toBeUndefined()
  })

  it("returns undefined for another host's target", () => {
    expect(readOpencodeTarget({ host: "codex", model: "gpt-5.6-sol" })).toBeUndefined()
  })

  it("drops a boolean variant rather than stringifying it", () => {
    // `variant` names an effort level and the host validates it against the
    // model's resolved variant map. `"true"` would not be a lenient reading of
    // a mistyped toggle, it would be a value guaranteed to fail the delegation.
    expect(readOpencodeTarget(target("openai/gpt-5", true))).toEqual({ model: "openai/gpt-5" })
  })

  it("ignores options it does not own", () => {
    const raw: SeatTarget = {
      host: "opencode",
      model: "openai/gpt-5",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "variant", value: "low" },
      ],
    }
    expect(readOpencodeTarget(raw)).toEqual({ model: "openai/gpt-5", variant: "low" })
  })

  it("survives anything a hand-edited config can hold", () => {
    for (const value of [undefined, null, [], {}, { host: "opencode", model: "" }, { host: "opencode", options: "high" }]) {
      expect(() => readOpencodeTarget(value as SeatTarget)).not.toThrow()
      expect(readOpencodeTarget(value as SeatTarget)).toBeUndefined()
    }
  })
})

describe("the OpenCode adapter's capabilities", () => {
  it("reports control as supported and a reload as required", () => {
    /**
     * OpenCode is the only host that can genuinely make a delegated child run a
     * chosen model, via a generated agent definition plus the `general`-only
     * `subagent_type` rewrite. `requiresReload` is true because agent
     * definitions are read once at startup: a file written now does nothing
     * until the host restarts, and a UI that does not say so leaves the user
     * watching a setting apparently fail.
     */
    expect(createOpencodeAdapter().capabilities(OPENCODE_DEFAULT_PROFILE)).toEqual({
      discovery: "cached",
      childModel: "supported",
      childReasoning: "supported",
      requiresReload: true,
    })
  })

  it("names itself and its default profile with the key seat targets are filed under", () => {
    const adapter = createOpencodeAdapter()
    expect(adapter.kind).toBe("opencode")
    expect(adapter.profiles()).toEqual([{ id: "opencode:default", host: "opencode", label: "OpenCode" }])
  })

  it("hands out copies of its profiles, so a caller cannot mutate the adapter", () => {
    const adapter = createOpencodeAdapter()
    const first = adapter.profiles()[0]
    if (first) first.label = "tampered"
    expect(adapter.profiles()[0]?.label).toBe("OpenCode")
  })
})

describe("the OpenCode adapter's catalogue", () => {
  it("exposes variant as a select built from the model's declared efforts", () => {
    const result = createOpencodeAdapter({ readModels: models(OPUS) }).catalogue(OPENCODE_DEFAULT_PROFILE)

    expect(result.models).toEqual([
      {
        id: "anthropic/claude-opus-4-5",
        label: "Claude Opus 4.5",
        contextWindow: 200_000,
        options: [
          {
            id: "variant",
            label: "Reasoning effort",
            type: "select",
            choices: [
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
            ],
          },
        ],
      },
    ])
    expect(result.freshness).toBe("cached")
    expect(result.warnings).toEqual([])
  })

  it("offers no variant control at all for a model that takes no reasoning effort", () => {
    // Not an empty dropdown: 3,506 of today's models are in this state and
    // every one rejects every variant. "There is no control here" is the
    // honest render, and an absent descriptor is how a UI knows to draw it.
    const result = createOpencodeAdapter({ readModels: models(HAIKU) }).catalogue(OPENCODE_DEFAULT_PROFILE)
    expect(result.models[0]?.options).toEqual([])
  })

  it("labels the suggestion as a suggestion when the catalogue cannot tell", () => {
    // 940 models are in this state. `SEAT_VARIANTS` is a union across the whole
    // catalogue, not a valid-everywhere enum, so the control must not present
    // it as one — the host keeps the last word.
    const result = createOpencodeAdapter({ readModels: models(SONNET) }).catalogue(OPENCODE_DEFAULT_PROFILE)
    const option = result.models[0]?.options[0]
    expect(option?.label).toBe("Reasoning effort (suggested)")
    expect(option?.choices?.map((choice) => choice.id)).toEqual([...SEAT_VARIANTS])
  })

  it("explains an empty list instead of looking broken", () => {
    const result = createOpencodeAdapter({ readModels: models() }).catalogue(OPENCODE_DEFAULT_PROFILE)
    expect(result.models).toEqual([])
    expect(result.freshness).toBe("unknown")
    expect(result.warnings.join("\n")).toMatch(/model catalogue/)
  })

  it("says so when asked for a profile it does not serve", () => {
    const result = createOpencodeAdapter({ readModels: models(OPUS) }).catalogue("opencode:work")
    expect(result.warnings.join("\n")).toContain("is not a configured OpenCode profile")
  })

  it("reads the catalogue at most once per adapter", () => {
    let reads = 0
    const adapter = createOpencodeAdapter({
      readModels: () => {
        reads += 1
        return [OPUS]
      },
    })
    adapter.catalogue(OPENCODE_DEFAULT_PROFILE)
    adapter.catalogue(OPENCODE_DEFAULT_PROFILE)
    adapter.diagnose(OPENCODE_DEFAULT_PROFILE, "opencode:default", target(OPUS.id, "high"), "arjun-mehta")
    expect(reads).toBe(1)
  })

  it("never reads the catalogue for a config that pairs no model with a variant", () => {
    // The 4 MB parse is the whole cost of this adapter, and the common case has
    // to pay nothing for it.
    let reads = 0
    const adapter = createOpencodeAdapter({
      readModels: () => {
        reads += 1
        return [OPUS]
      },
    })
    adapter.diagnose(OPENCODE_DEFAULT_PROFILE, "opencode:default", target(OPUS.id), "arjun-mehta")
    adapter.diagnose(OPENCODE_DEFAULT_PROFILE, "opencode:default", target("claude-opus-4-5", "high"), "arjun-mehta")
    expect(reads).toBe(0)
  })
})

describe("the OpenCode adapter's diagnosis", () => {
  const adapter = createOpencodeAdapter({ readModels: models(OPUS, HAIKU, SONNET) })
  const diagnose = (raw: SeatTarget) => adapter.diagnose(OPENCODE_DEFAULT_PROFILE, "opencode:default", raw, "arjun-mehta")

  it("owns the provider/model slash rule, and scopes the finding to a row", () => {
    const [issue] = diagnose(target("claude-opus-4-5"))
    expect(issue?.code).toBe("malformed-model")
    expect(issue?.severity).toBe("error")
    expect(issue?.message).toContain("missing its provider")
    // A UI cannot put a finding on the right row without these; target keys
    // contain `:` and may contain `.`, so splitting `path` back apart is not safe.
    expect(issue?.employeeId).toBe("arjun-mehta")
    expect(issue?.targetId).toBe("opencode:default")
    expect(issue?.host).toBe("opencode")
    expect(issue?.path).toBe("seats.employees.arjun-mehta.targets.opencode:default.model")
  })

  it("says nothing about a well-formed model with a declared variant", () => {
    expect(diagnose(target(OPUS.id, "high"))).toEqual([])
  })

  it("refuses a variant the model does not declare", () => {
    const [issue] = diagnose(target(OPUS.id, "xhigh"))
    expect(issue?.code).toBe("unrecognised-variant")
    // An error, not a warning: severity is what stops the file being written,
    // which is what turns a delegation that would fail at use time into a no-op.
    expect(issue?.severity).toBe("error")
    expect(issue?.message).toContain(`"xhigh" is not one anthropic/claude-opus-4-5 offers (low, medium, high)`)
  })

  it("refuses any variant on a model that takes no reasoning effort", () => {
    expect(diagnose(target(HAIKU.id, "high"))[0]?.message).toContain("takes no reasoning effort")
  })

  it("lets a variant through when the catalogue cannot rule on the model", () => {
    // An unknown model is not a wrong model. OpenCode synthesises variants for
    // mechanisms the catalogue cannot read an effort scale off, so refusing
    // here would break a user whose provider ships faster than models.dev.
    expect(diagnose(target(SONNET.id, "high"))).toEqual([])
    expect(diagnose(target("exotic/model-9", "xhigh"))).toEqual([])
  })

  it("reports a malformed model on its own, without a second sentence about the variant", () => {
    // Two sentences about one broken value, and a 4 MB parse to say the second.
    expect(diagnose(target("claude-opus-4-5", "xhigh"))).toHaveLength(1)
  })

  it("says nothing about another host's target", () => {
    expect(diagnose({ host: "codex", model: "gpt-5.6-sol" })).toEqual([])
  })

  it("says nothing about a target with no model", () => {
    // `options-without-model` is host-agnostic and `diagnoseSeats` already
    // raises it. Repeating it here would put two rows in the TUI for one mistake.
    expect(diagnose(target(undefined, "high"))).toEqual([])
  })
})

describe("the adapter registry", () => {
  it("claims opencode", () => {
    expect(seatAdapter("opencode")?.kind).toBe("opencode")
    expect(seatAdapters().some((adapter) => adapter.kind === "opencode")).toBe(true)
  })

  it("returns undefined for a host nothing has claimed, and for a typo", () => {
    // Absent means "no adapter has claimed this host yet"; `unsupported` means
    // "an adapter has looked and the host cannot do it". A placeholder entry
    // would make the two indistinguishable.
    expect(seatAdapter("openkode")).toBeUndefined()
    expect(seatAdapter("")).toBeUndefined()
  })

  it("does not hand back something off Object.prototype", () => {
    // The key comes from a hand-edited config file. A plain lookup on an object
    // literal answers `toString` with a function, which would then blow up on
    // `.diagnose` somewhere far away from the typo that caused it.
    for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(seatAdapter(key), key).toBeUndefined()
    }
  })
})

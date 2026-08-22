import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  type CatalogueSources,
  buildCatalogue,
  formatContext,
  groupByProvider,
  parseHostModels,
  variantsFor,
} from "../dist/index.js"

/**
 * The catalogue's merge rules, exercised against small hand-written snapshots
 * rather than the real 4 MB models.json.
 *
 * The fixture is deliberately shaped like the real file — a provider map whose
 * models carry `limit.context` and a `reasoning_options` array of mechanisms —
 * and it carries one model of every shape that array takes in the wild,
 * because the shape is what decides whether Observer may speak for a model's
 * efforts at all:
 *
 *   pure `effort`            claude-opus-4-8     offer them
 *   `toggle` + `effort`      claude-haiku-4      offer them; toggle is not a variant
 *   `effort` + budget_tokens claude-opus-4-5     offer them; effort wins
 *   pure `budget_tokens`     claude-sonnet-4-5   we cannot tell
 *   absent                   gpt-4o              genuinely none
 *   empty `[]`               gpt-4o-mini         genuinely none
 */
const CATALOGUE = JSON.stringify({
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-4-8": {
        name: "Claude Opus 4.8",
        release_date: "2026-02-01",
        tool_call: true,
        limit: { context: 1_000_000, output: 64_000 },
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      },
      "claude-opus-4-5": {
        name: "Claude Opus 4.5",
        release_date: "2025-11-01",
        tool_call: true,
        limit: { context: 200_000 },
        reasoning_options: [
          { type: "effort", values: ["low", "medium", "high"] },
          { type: "budget_tokens", min: 1024 },
        ],
      },
      "claude-sonnet-4-5": {
        name: "Claude Sonnet 4.5",
        release_date: "2025-09-29",
        tool_call: true,
        limit: { context: 200_000 },
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
      },
      "claude-haiku-4": {
        name: "Claude Haiku 4",
        release_date: "2025-06-01",
        tool_call: true,
        limit: { context: 200_000 },
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high"] }],
      },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5-nano": {
        name: "GPT-5 Nano",
        release_date: "2025-08-01",
        tool_call: true,
        limit: { context: 400_000 },
        reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
      },
      "gpt-4o-mini": {
        name: "GPT-4o mini",
        release_date: "2024-07-01",
        tool_call: true,
        limit: { context: 128_000 },
        reasoning_options: [],
      },
      "gpt-4o": {
        name: "GPT-4o",
        release_date: "2024-05-01",
        tool_call: true,
        limit: { context: 128_000 },
      },
      "gpt-image-1.5": {
        name: "gpt-image-1.5",
        tool_call: false,
        limit: { context: 0 },
      },
    },
  },
})

/**
 * No developer's real catalogue may decide what these assertions see.
 *
 * Everything under test here is pure today, but `catalogueCachePath` and
 * `authCachePath` resolve XDG before HOME, and a test that grows an I/O path
 * later would silently start reading the 7 000-model file on the machine
 * running it. Scrubbing up front makes that impossible rather than unlikely.
 */
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const key of ["XDG_CACHE_HOME", "XDG_DATA_HOME"]) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function build(sources: CatalogueSources = {}): ReturnType<typeof buildCatalogue> {
  return buildCatalogue({ catalogue: CATALOGUE, ...sources })
}

describe("buildCatalogue", () => {
  it("reads models, context windows and effort scales out of the OpenCode cache", () => {
    const models = build()
    const opus = models.find((model) => model.id === "anthropic/claude-opus-4-8")
    expect(opus).toBeDefined()
    expect(opus?.provider).toBe("anthropic")
    expect(opus?.providerLabel).toBe("Anthropic")
    expect(opus?.label).toBe("Claude Opus 4.8")
    expect(opus?.contextWindow).toBe(1_000_000)
    expect(opus?.variants).toEqual({ kind: "efforts", values: ["low", "medium", "high", "xhigh", "max"] })
    expect(opus?.known).toBe(true)
  })

  it("takes the effort scale and ignores the other reasoning mechanisms beside it", () => {
    // `toggle` and `budget_tokens` sit in the same array but neither names a
    // variant, so neither may reach the picker. Confirmed against a live host:
    // a model declaring `[toggle, effort]` resolves to exactly the effort
    // values, and so does one declaring `[effort, budget_tokens]`.
    expect(build().find((model) => model.id === "anthropic/claude-haiku-4")?.variants).toEqual({
      kind: "efforts",
      values: ["low", "medium", "high"],
    })
    expect(build().find((model) => model.id === "anthropic/claude-opus-4-5")?.variants).toEqual({
      kind: "efforts",
      values: ["low", "medium", "high"],
    })
  })

  it("drops models a subagent cannot use", () => {
    expect(build().some((model) => model.id === "openai/gpt-image-1.5")).toBe(false)
  })

  it("orders providers alphabetically and models newest-first inside each", () => {
    expect(build().map((model) => model.id)).toEqual([
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-haiku-4",
      "openai/gpt-5-nano",
      "openai/gpt-4o-mini",
      "openai/gpt-4o",
    ])
  })

  it("narrows to providers the user holds credentials for", () => {
    const models = build({ authenticated: ["openai"] })
    expect(new Set(models.map((model) => model.provider))).toEqual(new Set(["openai"]))
    expect(models.length).toBeGreaterThan(0)
  })

  it("marks a model the host says takes no variant at all as unknown when it also knows nothing else", () => {
    // `github-copilot/claude-opus-4.8-fast` and friends: the host lists them,
    // models.dev has never indexed them, and they routinely do accept efforts.
    // "not in the catalogue" must never be read as "no efforts".
    const models = build({ available: ["github-copilot/claude-opus-4.8-fast"] })
    expect(models[0]?.variants).toEqual({ kind: "unknown" })
  })

  it("keeps OpenCode's own free provider without a credential", () => {
    const catalogue = JSON.stringify({
      opencode: { id: "opencode", name: "OpenCode", models: { "big-pickle": { name: "Big Pickle" } } },
      anthropic: { id: "anthropic", name: "Anthropic", models: { "claude-opus-4-8": { name: "Opus" } } },
    })
    const models = buildCatalogue({ catalogue, authenticated: ["mistral"] })
    expect(models.map((model) => model.id)).toEqual(["opencode/big-pickle"])
  })

  it("lets the host's own list win, and enriches it from the cache", () => {
    const models = build({ available: ["openai/gpt-5-nano", "anthropic/claude-opus-4-8"] })
    expect(models).toHaveLength(2)
    expect(models.find((model) => model.id === "openai/gpt-5-nano")?.contextWindow).toBe(400_000)
  })

  it("still offers a host model the cache has never heard of, marked unknown", () => {
    const models = build({ available: ["github-copilot/claude-opus-4.8-fast"] })
    expect(models).toHaveLength(1)
    expect(models[0]?.known).toBe(false)
    expect(models[0]?.label).toBe("claude-opus-4.8-fast")
    expect(models[0]?.providerLabel).toBe("github-copilot")
  })

  it("pins an already-configured model past the credential filter, with full metadata", () => {
    // The lapsed-key case: the seat names an Anthropic model, the user has no
    // Anthropic credential, and the picker still has to be able to show and
    // edit it.
    const models = build({ authenticated: ["openai"], include: ["anthropic/claude-opus-4-8"] })
    const pinned = models.find((model) => model.id === "anthropic/claude-opus-4-8")
    expect(pinned?.known).toBe(true)
    expect(pinned?.contextWindow).toBe(1_000_000)
    expect(pinned?.variants).toEqual({ kind: "efforts", values: ["low", "medium", "high", "xhigh", "max"] })
  })

  it("does not list a pinned model twice", () => {
    const models = build({ include: ["anthropic/claude-opus-4-8"] })
    expect(models.filter((model) => model.id === "anthropic/claude-opus-4-8")).toHaveLength(1)
  })

  it("pins a model the catalogue has never heard of", () => {
    const models = build({ authenticated: ["openai"], include: ["bedrock/anthropic.claude-v9"] })
    const pinned = models.find((model) => model.id === "bedrock/anthropic.claude-v9")
    expect(pinned?.known).toBe(false)
  })

  it("returns nothing rather than throwing on a corrupt or absent catalogue", () => {
    expect(buildCatalogue({ catalogue: "{ not json" })).toEqual([])
    expect(buildCatalogue({})).toEqual([])
    expect(buildCatalogue({ catalogue: JSON.stringify([1, 2, 3]) })).toEqual([])
  })

  it("ignores host lines that are not provider/model", () => {
    expect(build({ available: ["nonsense", ""] }).length).toBeGreaterThan(0)
  })
})

/**
 * The three states, and the rule that they never collapse into two.
 *
 * Verified against a live OpenCode host (1.18.21) reading the resolved
 * `variants` map off `GET /provider` — the same map the task tool checks a
 * delegation's variant against — over all 7 202 models it lists.
 */
describe("variantsFor: what Observer may say about a model's efforts", () => {
  it("offers no effort at all without a model", () => {
    // The rule the whole effort control is built on: OpenCode applies a
    // variant only to an agent's own configured model.
    expect(variantsFor(build(), undefined)).toEqual({ values: [], known: true })
  })

  describe("state 1: known, and it has efforts", () => {
    it("offers exactly the values a pure effort scale declares", () => {
      expect(variantsFor(build(), "anthropic/claude-opus-4-8")).toEqual({
        values: ["low", "medium", "high", "xhigh", "max"],
        known: true,
      })
    })

    it("offers the effort scale of a model that also declares a toggle", () => {
      // The host resolves `[toggle, effort]` to exactly the effort values: the
      // toggle is a mechanism, not a variant.
      expect(variantsFor(build(), "anthropic/claude-haiku-4")).toEqual({
        values: ["low", "medium", "high"],
        known: true,
      })
    })

    it("offers the effort scale of a model that also declares budget_tokens", () => {
      // `[effort, budget_tokens]` resolves to the effort values too. An effort
      // entry beside another mechanism is still an answer.
      expect(variantsFor(build(), "anthropic/claude-opus-4-5")).toEqual({
        values: ["low", "medium", "high"],
        known: true,
      })
    })
  })

  describe("state 2: known, and it genuinely has none", () => {
    it("offers nothing, confidently, for a model with no reasoning_options at all", () => {
      // gpt-4o. Measured on the host: every one of the 3 506 catalogued models
      // with no mechanisms resolved to an empty variant map, without exception.
      // This is a finding, not a shrug, and `known: true` is what says so.
      expect(variantsFor(build(), "openai/gpt-4o")).toEqual({ values: [], known: true })
    })

    it("treats an empty reasoning_options array the same as an absent one", () => {
      expect(variantsFor(build(), "openai/gpt-4o-mini")).toEqual({ values: [], known: true })
    })
  })

  describe("state 3: we cannot tell, so we do not pretend", () => {
    it("DOES NOT CLAIM A BUDGET_TOKENS MODEL TAKES NO EFFORT", () => {
      /**
       * The defect this whole change exists for.
       *
       * `reasoning_options` is a list of *mechanisms*, and OpenCode
       * synthesises a variant map for the ones that are not `effort` using
       * rules keyed on the model family and the provider's SDK — neither of
       * which is on disk. Reading an absent `effort` entry as "no efforts"
       * mislabelled 958 catalogued models, 336 of them `budget_tokens`,
       * `claude-sonnet-4-5` among them.
       *
       * On the live host those 940 split 594 with no variants against 346
       * with synthesised ones. That is a coin flip, so the only honest answer
       * is `known: false` — and `known: false` is the one that falls back to
       * SEAT_VARIANTS and warns instead of asserting.
       */
      const result = variantsFor(build(), "anthropic/claude-sonnet-4-5")
      expect(result.known).toBe(false)
      expect(result.values).toContain("high")
      expect(result.values).toContain("max")
    })

    it("keeps that distinct from a model that really does take no effort", () => {
      // The two states that used to be one. gpt-4o is silent because it has
      // nothing to say; claude-sonnet-4-5 is silent because we cannot hear it.
      const none = variantsFor(build(), "openai/gpt-4o")
      const cannotTell = variantsFor(build(), "anthropic/claude-sonnet-4-5")
      expect(none).not.toEqual(cannotTell)
      expect(none.known).toBe(true)
      expect(cannotTell.known).toBe(false)
    })

    it("falls back to the suggestion list for a model it cannot find, and says so", () => {
      const result = variantsFor(build(), "someone/else")
      expect(result.known).toBe(false)
      expect(result.values).toContain("high")
      expect(result.values).toContain("max")
    })
  })
})

/**
 * The host's own resolved map, which outranks every inference above.
 *
 * `opencode models --verbose` prints each model's `variants` map, and that map
 * is what the task tool validates against. Where we have it there is nothing
 * left to derive — including for the models the derivation provably cannot get
 * right, like the five provider SDKs that accept no variant whatever their
 * models declare in models.dev.
 */
describe("buildCatalogue: variants reported by the host", () => {
  it("takes the host's list over the catalogue's effort scale", () => {
    const models = build({ variants: { "anthropic/claude-opus-4-8": ["low", "high"] } })
    expect(models.find((model) => model.id === "anthropic/claude-opus-4-8")?.variants).toEqual({
      kind: "efforts",
      values: ["low", "high"],
    })
  })

  it("believes the host when it says a model takes no variant despite declaring an effort scale", () => {
    // Measured: 48 models across `@aihubmix/ai-sdk-provider`,
    // `@ai-sdk/perplexity`, `gitlab-ai-provider`, `@qvac/ai-sdk-provider` and
    // `watsonx-ai-provider` publish a full effort scale and resolve to no
    // variants at all, because the host's synthesis is keyed on the provider's
    // SDK. Nothing on disk distinguishes them, so only the host can say.
    const models = build({ variants: { "anthropic/claude-opus-4-8": [] } })
    expect(models.find((model) => model.id === "anthropic/claude-opus-4-8")?.variants).toEqual({ kind: "none" })
    expect(variantsFor(models, "anthropic/claude-opus-4-8")).toEqual({ values: [], known: true })
  })

  it("resolves a model the catalogue never described once the host reports its variants", () => {
    const models = build({
      available: ["github-copilot/claude-opus-4.8-fast"],
      variants: { "github-copilot/claude-opus-4.8-fast": ["low", "medium", "high"] },
    })
    expect(models[0]?.known).toBe(false)
    expect(variantsFor(models, "github-copilot/claude-opus-4.8-fast")).toEqual({
      values: ["low", "medium", "high"],
      known: true,
    })
  })

  it("leaves the derivation alone for a model the host did not mention", () => {
    // An absent key is not an empty map. A partial report may not silence
    // models it never spoke about.
    const models = build({ variants: { "openai/gpt-5-nano": ["high"] } })
    expect(models.find((model) => model.id === "anthropic/claude-sonnet-4-5")?.variants).toEqual({ kind: "unknown" })
    expect(models.find((model) => model.id === "openai/gpt-4o")?.variants).toEqual({ kind: "none" })
  })
})

describe("groupByProvider", () => {
  it("keeps providers contiguous and in catalogue order", () => {
    expect(groupByProvider(build()).map((group) => group.label)).toEqual(["Anthropic", "OpenAI"])
    expect(groupByProvider(build())[0]?.models).toHaveLength(4)
  })
})

describe("formatContext", () => {
  it("reads at a glance in a fixed-width column", () => {
    expect(formatContext(1_048_576)).toBe("1M")
    expect(formatContext(1_000_000)).toBe("1M")
    expect(formatContext(200_000)).toBe("200K")
    expect(formatContext(128_000)).toBe("128K")
    expect(formatContext(512)).toBe("512")
    expect(formatContext(0)).toBe("-")
    expect(formatContext(undefined)).toBe("-")
  })
})

/**
 * Reading the host's own answer out of `opencode models --verbose`.
 *
 * The fixture is real output, trimmed: a `provider/model` header line, then
 * the resolved record pretty-printed with its braces alone in column zero.
 * `variants` is the map the task tool validates a delegation's variant
 * against, which is why this parser exists at all.
 */
describe("parseHostModels", () => {
  const OUTPUT = [
    "anthropic/claude-opus-4-8",
    "{",
    '  "id": "claude-opus-4-8",',
    '  "providerID": "anthropic",',
    '  "name": "Claude Opus 4.8",',
    '  "api": { "npm": "@ai-sdk/anthropic" },',
    '  "variants": {',
    '    "low": { "reasoningEffort": "low" },',
    '    "max": { "reasoningEffort": "max" }',
    "  }",
    "}",
    "openai/gpt-4o",
    "{",
    '  "id": "gpt-4o",',
    '  "providerID": "openai",',
    '  "variants": {}',
    "}",
    "",
  ].join("\n")

  it("reads each model's resolved variant map", () => {
    expect(parseHostModels(OUTPUT)).toEqual({
      ids: ["anthropic/claude-opus-4-8", "openai/gpt-4o"],
      variants: { "anthropic/claude-opus-4-8": ["low", "max"], "openai/gpt-4o": [] },
    })
  })

  it("rebuilds the id from the record, not the header line", () => {
    // A model id may itself contain a slash, so splitting the header would
    // guess the boundary wrong and produce an id no seat could ever match.
    const output = [
      "hpc-ai/deepseek/deepseek-v4-flash",
      "{",
      '  "id": "deepseek/deepseek-v4-flash",',
      '  "providerID": "hpc-ai",',
      '  "variants": { "high": {} }',
      "}",
    ].join("\n")
    expect(parseHostModels(output).ids).toEqual(["hpc-ai/deepseek/deepseek-v4-flash"])
    expect(parseHostModels(output).variants["hpc-ai/deepseek/deepseek-v4-flash"]).toEqual(["high"])
  })

  it("says nothing about a model whose record carries no variants key", () => {
    // An absent key is not an empty map. Only a map the host actually rendered
    // may overrule the catalogue; anything else leaves the derivation alone.
    const output = ['x/y', "{", '  "id": "y",', '  "providerID": "x"', "}"].join("\n")
    const parsed = parseHostModels(output)
    expect(parsed.ids).toEqual(["x/y"])
    expect(parsed.variants).toEqual({})
  })

  it("skips a record it cannot parse rather than losing the run", () => {
    const output = [OUTPUT, "broken/model", "{", "  not json at all", "}"].join("\n")
    expect(parseHostModels(output).ids).toEqual(["anthropic/claude-opus-4-8", "openai/gpt-4o"])
  })

  it("returns nothing for output that is not verbose at all", () => {
    expect(parseHostModels("anthropic/claude-opus-4-8\nopenai/gpt-4o\n")).toEqual({ ids: [], variants: {} })
    expect(parseHostModels("")).toEqual({ ids: [], variants: {} })
  })
})

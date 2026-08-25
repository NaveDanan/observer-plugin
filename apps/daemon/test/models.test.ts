import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
// Straight from source rather than the package barrel, which resolves to
// `dist` and would test whatever was last compiled.
import {
  contextTierWindowsFor,
  contextTiersFor,
  contextWindowsFor,
  refreshCopilotModelMetadata,
} from "../src/models.js"

/**
 * A models.dev snapshot, in the shape the real 4 MB file uses.
 *
 * Injected as a string rather than read from `~/.cache/opencode`, so these
 * assertions do not depend on which catalogue the developer running them
 * happens to have downloaded.
 */
const SNAPSHOT = JSON.stringify({
  "github-copilot": {
    name: "GitHub Copilot",
    models: {
      "claude-opus-5": { name: "Claude Opus 5", limit: { context: 1_000_000, output: 64_000 } },
      "gpt-5.6-sol": {
        name: "GPT-5.6 Sol",
        limit: { context: 1_050_000, output: 128_000 },
        cost: {
          input: 2.5,
          output: 15,
          tiers: [{ input: 5, output: 22.5, tier: { type: "context", size: 272_000 } }],
          context_over_200k: { input: 5, output: 22.5 },
        },
      },
      "gpt-4.1": { name: "GPT-4.1", limit: { context: 128_000 } },
      // Tiered, but by something that is not context. Offering `long_context`
      // here would be exactly the false control the picker refuses.
      "kimi-k3": {
        name: "Kimi K3",
        limit: { context: 256_000 },
        cost: { input: 1, tiers: [{ input: 2, tier: { type: "volume", size: 1_000_000 } }] },
      },
      "text-embedding-3": { name: "Embeddings" },
    },
  },
  anthropic: {
    name: "Anthropic",
    models: { "claude-opus-4-5": { name: "Claude Opus 4.5", limit: { context: 200_000 } } },
  },
})

describe("contextWindowsFor", () => {
  it("keys one provider's models by the bare id a host would name them with", () => {
    const windows = contextWindowsFor("github-copilot", SNAPSHOT)
    expect(windows.get("claude-opus-5")).toBe(1_000_000)
    expect(windows.get("gpt-5.6-sol")).toBe(1_050_000)
    expect(windows.get("gpt-4.1")).toBe(128_000)
    // The catalogue stores `github-copilot/gpt-4.1`; Copilot CLI says `gpt-4.1`.
    // A map keyed the catalogue's way would answer nothing.
    expect(windows.has("github-copilot/gpt-4.1")).toBe(false)
  })

  it("leaves out models that publish no size, rather than guessing one", () => {
    const windows = contextWindowsFor("github-copilot", SNAPSHOT)
    expect(windows.has("text-embedding-3")).toBe(false)
  })

  it("answers for one provider only", () => {
    const windows = contextWindowsFor("github-copilot", SNAPSHOT)
    expect(windows.has("claude-opus-4-5")).toBe(false)
    expect(contextWindowsFor("anthropic", SNAPSHOT).get("claude-opus-4-5")).toBe(200_000)
  })

  it("is empty for a provider the snapshot does not carry", () => {
    expect(contextWindowsFor("no-such-provider", SNAPSHOT).size).toBe(0)
  })

  it("survives a missing, empty or malformed snapshot", () => {
    for (const raw of ["", "not json", "[]", "null", '{"github-copilot":42}']) {
      expect(contextWindowsFor("github-copilot", raw).size).toBe(0)
    }
  })
})

describe("contextTiersFor", () => {
  it("names the models whose price sheet carries a context tier", () => {
    const tiered = contextTiersFor("github-copilot", SNAPSHOT)
    expect(tiered.has("gpt-5.6-sol")).toBe(true)
    // The catalogue stores `github-copilot/gpt-5.6-sol`; Copilot CLI says the
    // bare id, and a set keyed the catalogue's way would match nothing.
    expect(tiered.has("github-copilot/gpt-5.6-sol")).toBe(false)
  })

  it("leaves out models with no tiers at all", () => {
    const tiered = contextTiersFor("github-copilot", SNAPSHOT)
    expect(tiered.has("claude-opus-5")).toBe(false)
    expect(tiered.has("gpt-4.1")).toBe(false)
  })

  it("leaves out models tiered by something that is not context", () => {
    expect(contextTiersFor("github-copilot", SNAPSHOT).has("kimi-k3")).toBe(false)
  })

  it("answers for one provider only", () => {
    expect(contextTiersFor("anthropic", SNAPSHOT).has("gpt-5.6-sol")).toBe(false)
  })

  it("is empty for a missing, empty or malformed snapshot, so the control stays withheld", () => {
    for (const raw of ["", "not json", "[]", "null", '{"github-copilot":42}']) {
      expect(contextTiersFor("github-copilot", raw).size).toBe(0)
    }
    expect(contextTiersFor("no-such-provider", SNAPSHOT).size).toBe(0)
  })
})

describe("contextTierWindowsFor", () => {
  it("turns the model list's prompt and output limits into total context windows", () => {
    expect(contextTierWindowsFor("github-copilot", SNAPSHOT).get("gpt-5.6-sol")).toEqual({
      standard: 400_000,
      maximum: 1_050_000,
    })
  })

  it("omits a tier when the model list lacks the output allowance needed for a total", () => {
    const incomplete = SNAPSHOT.replace('limit":{"context":1050000,"output":128000}', 'limit":{"context":1050000}')
    expect(contextTierWindowsFor("github-copilot", incomplete).has("gpt-5.6-sol")).toBe(false)
  })
})

describe("refreshCopilotModelMetadata", () => {
  it("caches Copilot context metadata without depending on OpenCode", async () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "observer-model-metadata-"))
    const previous = process.env["XDG_CACHE_HOME"]
    process.env["XDG_CACHE_HOME"] = cacheHome
    try {
      const freshness = await refreshCopilotModelMetadata({
        now: () => 10_000,
        fetch: async () => new Response(SNAPSHOT, { status: 200 }),
      })

      expect(freshness).toBe("live")
      expect(contextWindowsFor("github-copilot").get("claude-opus-5")).toBe(1_000_000)
      const cache = JSON.parse(
        readFileSync(join(cacheHome, "observer", "copilot-models.json"), "utf8"),
      ) as { catalogue?: Record<string, unknown> }
      expect(Object.keys(cache.catalogue ?? {})).toEqual(["github-copilot"])
    } finally {
      if (previous === undefined) delete process.env["XDG_CACHE_HOME"]
      else process.env["XDG_CACHE_HOME"] = previous
      rmSync(cacheHome, { recursive: true, force: true })
    }
  })

  it("uses a fresh cache without making another launch request", async () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "observer-model-metadata-"))
    const previous = process.env["XDG_CACHE_HOME"]
    process.env["XDG_CACHE_HOME"] = cacheHome
    let requests = 0
    const fetcher: typeof globalThis.fetch = async () => {
      requests++
      return new Response(SNAPSHOT, { status: 200 })
    }
    try {
      await refreshCopilotModelMetadata({ now: () => 10_000, fetch: fetcher })
      const freshness = await refreshCopilotModelMetadata({ now: () => 10_001, fetch: fetcher })

      expect(freshness).toBe("cached")
      expect(requests).toBe(1)
    } finally {
      if (previous === undefined) delete process.env["XDG_CACHE_HOME"]
      else process.env["XDG_CACHE_HOME"] = previous
      rmSync(cacheHome, { recursive: true, force: true })
    }
  })

  it("keeps stale context metadata when the launch refresh fails", async () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "observer-model-metadata-"))
    const previous = process.env["XDG_CACHE_HOME"]
    process.env["XDG_CACHE_HOME"] = cacheHome
    try {
      await refreshCopilotModelMetadata({
        now: () => 10_000,
        fetch: async () => new Response(SNAPSHOT, { status: 200 }),
      })
      const freshness = await refreshCopilotModelMetadata({
        now: () => 100_000_000,
        fetch: async () => new Response("", { status: 503 }),
      })

      expect(freshness).toBe("stale")
      expect(contextWindowsFor("github-copilot").get("gpt-5.6-sol")).toBe(1_050_000)
    } finally {
      if (previous === undefined) delete process.env["XDG_CACHE_HOME"]
      else process.env["XDG_CACHE_HOME"] = previous
      rmSync(cacheHome, { recursive: true, force: true })
    }
  })
})

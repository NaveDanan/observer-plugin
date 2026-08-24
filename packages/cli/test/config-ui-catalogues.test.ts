import { describe, expect, it } from "vitest"
import type { HostSeatAdapter, ModelCatalogue } from "../../../apps/daemon/src/adapters/types.js"
import type { TargetProfile } from "../src/config-ui-state.js"
import { preloadCopilotCatalogues } from "../src/config-ui-catalogues.js"

const CAPABILITIES = {
  discovery: "live" as const,
  childModel: "supported" as const,
  childReasoning: "supported" as const,
  requiresReload: true,
}

const PROFILES: TargetProfile[] = [
  {
    id: "opencode:default",
    host: "opencode",
    hostLabel: "OpenCode",
    profileLabel: "default",
    capabilities: CAPABILITIES,
  },
  {
    id: "copilot:default",
    host: "copilot",
    hostLabel: "GitHub Copilot CLI",
    profileLabel: "default",
    capabilities: CAPABILITIES,
  },
]

function adapter(catalogue: ModelCatalogue, calls: string[]): HostSeatAdapter {
  return {
    kind: "copilot",
    label: "GitHub Copilot CLI",
    profiles: () => [],
    catalogue: (profileId) => {
      calls.push(profileId)
      return catalogue
    },
    diagnose: () => [],
    capabilities: () => CAPABILITIES,
  }
}

describe("Copilot catalogue launch preload", () => {
  it("loads the Copilot target before the first frame without probing other hosts", () => {
    const calls: string[] = []
    const catalogue: ModelCatalogue = {
      models: [{ id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 1_000_000, options: [] }],
      source: "copilot help config",
      freshness: "live",
      warnings: [],
    }

    const catalogues = preloadCopilotCatalogues([adapter(catalogue, calls)], PROFILES)
    expect(calls).toEqual(["copilot:default"])
    expect(catalogues["copilot:default"]?.models[0]?.contextWindow).toBe(1_000_000)
    expect(catalogues["opencode:default"]).toBeUndefined()
  })

  it("omits an empty launch result so opening the picker retries it", () => {
    const calls: string[] = []
    const empty: ModelCatalogue = {
      models: [],
      source: "copilot",
      freshness: "unknown",
      warnings: ["warming up"],
    }

    expect(preloadCopilotCatalogues([adapter(empty, calls)], PROFILES)).toEqual({})
    expect(calls).toEqual(["copilot:default"])
  })
})

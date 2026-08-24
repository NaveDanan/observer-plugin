import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
// Straight from source rather than the package barrel, which resolves to
// `dist` and would test whatever was last compiled.
import {
  ENTITLEMENT_TTL_MS,
  type EntitlementRefresh,
  probeCopilotEntitlement,
  resetEntitlementCooldown,
  writeEntitlementCache,
} from "../../src/adapters/copilot-entitlement.js"

/**
 * Every test here injects `launch`, so no test ever runs the real driver.
 *
 * That is not tidiness. The real refresh spawns `copilot --acp` and creates a
 * session that persists in the developer's own `~/.copilot/session-store.db`,
 * and a suite that ran it would quietly litter the history of whoever ran it.
 */
let dir: string
let launched: EntitlementRefresh[]

function deps(now: number, overrides: Partial<Parameters<typeof probeCopilotEntitlement>[2]> = {}) {
  return {
    invocation: (binary: string) => ({ command: binary, args: ["--acp"] }),
    now: () => now,
    cachePath: () => join(dir, "entitlement.json"),
    launch: (refresh: EntitlementRefresh) => launched.push(refresh),
    ...overrides,
  }
}

function probe(now: number, overrides: Partial<Parameters<typeof probeCopilotEntitlement>[2]> = {}) {
  return probeCopilotEntitlement("copilot", { env: {}, timeoutMs: 6_000 }, deps(now, overrides))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "observer-entitlement-"))
  launched = []
  resetEntitlementCooldown()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  resetEntitlementCooldown()
})

describe("probeCopilotEntitlement", () => {
  it("says nothing at all when no answer has ever been cached", () => {
    const result = probe(10_000)
    // Not an empty set. An empty set would grey out every model in the picker.
    expect(result.models).toBeUndefined()
    expect(result.freshness).toBe("unknown")
  })

  it("starts a refresh in the background when it has nothing to say", () => {
    probe(10_000)
    expect(launched).toHaveLength(1)
    expect(launched[0]?.args[0]).toBe("-e")
  })

  it("returns a fresh cached answer without launching anything", () => {
    writeEntitlementCache(join(dir, "entitlement.json"), ["claude-opus-5", "gpt-5.4"], 10_000)
    const result = probe(10_000 + ENTITLEMENT_TTL_MS - 1)
    expect([...(result.models ?? [])].sort()).toEqual(["claude-opus-5", "gpt-5.4"])
    expect(result.freshness).toBe("cached")
    expect(launched).toHaveLength(0)
  })

  it("still answers from a stale cache while the refresh runs", () => {
    writeEntitlementCache(join(dir, "entitlement.json"), ["claude-opus-5"], 10_000)
    const result = probe(10_000 + ENTITLEMENT_TTL_MS)
    // A Copilot that is briefly unreachable is not evidence that the account
    // lost its models; dropping to "unknown" would ungrey the list mid-hiccup.
    expect([...(result.models ?? [])]).toEqual(["claude-opus-5"])
    expect(launched).toHaveLength(1)
  })

  it("starts only one refresh when several callers ask at once", () => {
    probe(10_000)
    probe(10_001)
    probe(10_002)
    expect(launched).toHaveLength(1)
  })

  it("passes the cache path to the child, which is what writes the answer", () => {
    probe(10_000)
    expect(launched[0]?.args[2]).toContain(join(dir, "entitlement.json").replace(/\\/g, "\\\\"))
  })

  it("ignores a corrupt cache rather than throwing", () => {
    for (const raw of ["", "not json", "null", "[]", '{"at":"soon","models":[]}', '{"at":1,"models":[]}']) {
      writeFileSync(join(dir, "entitlement.json"), raw, "utf8")
      resetEntitlementCooldown()
      expect(probe(10_000).models).toBeUndefined()
    }
  })

  it("survives an invocation builder that throws", () => {
    const result = probe(10_000, {
      invocation: () => {
        throw new Error("unsupported Windows command characters")
      },
    })
    expect(result.freshness).toBe("unknown")
    expect(launched).toHaveLength(0)
  })
})

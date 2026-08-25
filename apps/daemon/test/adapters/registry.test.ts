import { describe, expect, it } from "vitest"
// Straight from source, not the package barrel: `apps/daemon` resolves to
// `dist`, and importing the built copy would test whatever was last compiled.
import { seatAdapter, seatAdapters } from "../../src/adapters/index.js"
import { HOST_KINDS } from "../../src/providers.js"

/**
 * The registry, exercised through the two functions everything above it uses.
 *
 * Nothing in this file spawns. `seatAdapter()` builds an adapter; building one
 * is documented to launch no process, and these tests are the check on that:
 * they call `profiles()` and `capabilities()` freely and never `catalogue()`,
 * which is the one call that can reach a CLI.
 */
describe("the adapter registry", () => {
  it("claims opencode, codex, claude and copilot", () => {
    for (const host of ["opencode", "codex", "claude", "copilot"]) {
      expect(seatAdapter(host)?.kind, host).toBe(host)
    }
    const kinds = seatAdapters().map((adapter) => adapter.kind)
    expect(kinds).toEqual(["opencode", "codex", "claude", "copilot"])
  })

  it("hands back the same instance every time, so per-instance probe caches survive", () => {
    // A fresh adapter per lookup would throw away Claude's `--version` cache
    // and Codex's model/list TTL, turning a seat editor that calls
    // `catalogue()` per keystroke into a subprocess per character.
    expect(seatAdapter("claude")).toBe(seatAdapter("claude"))
    expect(seatAdapter("codex")).toBe(seatAdapter("codex"))
  })

  it("returns undefined for a host nothing has claimed, and for a typo", () => {
    // Absent means "no adapter has claimed this host yet"; `unsupported` means
    // "an adapter has looked and the host cannot do it". A placeholder entry
    // would make the two indistinguishable.
    expect(seatAdapter("cursor")).toBeUndefined()
    expect(seatAdapter("grok")).toBeUndefined()
    expect(seatAdapter("openkode")).toBeUndefined()
    expect(seatAdapter("")).toBeUndefined()
  })

  it("does not hand back something off Object.prototype", () => {
    // The key comes from a hand-edited config file. A plain lookup on an object
    // literal answers `toString` with a function — and now that the map holds
    // factories, an unguarded hit would be *called*, not merely returned.
    for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "prototype"]) {
      expect(seatAdapter(key), key).toBeUndefined()
    }
  })

  it("only ever claims a real HostKind", () => {
    // The registry is the switch every adapter is selected by. A key that is
    // not a `HostKind` is unreachable from a config, so it would be dead code
    // that still shows up in `/v1/hosts`.
    for (const adapter of seatAdapters()) {
      expect(HOST_KINDS as readonly string[], adapter.kind).toContain(adapter.kind)
    }
  })

  it("answers profiles and capabilities for every registered host without spawning", () => {
    for (const adapter of seatAdapters()) {
      const profiles = adapter.profiles()
      expect(Array.isArray(profiles), adapter.kind).toBe(true)
      for (const profile of profiles) {
        expect(profile.id.length, adapter.kind).toBeGreaterThan(0)
        expect(profile.host, adapter.kind).toBe(adapter.kind)
      }
      const capabilities = adapter.capabilities(profiles[0]?.id ?? "")
      expect(["live", "cached", "manual"], adapter.kind).toContain(capabilities.discovery)
      expect(["supported", "experimental", "unsupported"], adapter.kind).toContain(capabilities.childModel)
      expect(["supported", "experimental", "unsupported"], adapter.kind).toContain(capabilities.childReasoning)
      expect(typeof capabilities.requiresReload, adapter.kind).toBe("boolean")
    }
  })

  it("reports model pins for every supported harness", () => {
    expect(seatAdapter("opencode")?.capabilities("").childModel).toBe("supported")
    expect(seatAdapter("codex")?.capabilities("").childModel).toBe("supported")
    expect(seatAdapter("claude")?.capabilities("").childModel).toBe("supported")
    expect(seatAdapter("copilot")?.capabilities("").childModel).toBe("supported")
  })
})

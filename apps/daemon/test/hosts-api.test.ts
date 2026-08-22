import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Change } from "@observer-ai/protocol"
import { Broadcaster, DEFAULT_CONFIG, Diagnostics, Pipeline, createServer } from "@observer-ai/daemon"
import type { HostCapabilities, HostProfile, HostSeatAdapter, ModelCatalogue, ObserverConfig } from "@observer-ai/daemon"
import { Store } from "@observer-ai/storage"

/**
 * The `/v1/hosts` surface, exercised against fake adapters.
 *
 * Every host in this file is a stub. Nothing here launches `codex`, `claude`
 * or anything else — which is the point: the failure modes worth testing are a
 * CLI that is not installed and an adapter that throws, and a test that has to
 * uninstall someone's tooling to reach them is a test nobody runs.
 */

let home: string
let originalHome: string | undefined
const closers: Array<() => void> = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer-hosts-api-"))
  originalHome = process.env["OBSERVER_HOME"]
  process.env["OBSERVER_HOME"] = home
})

afterEach(() => {
  while (closers.length > 0) closers.pop()?.()
  if (originalHome === undefined) delete process.env["OBSERVER_HOME"]
  else process.env["OBSERVER_HOME"] = originalHome
  rmSync(home, { recursive: true, force: true })
})

function makeConfig(overrides: Partial<ObserverConfig> = {}): ObserverConfig {
  return {
    ...DEFAULT_CONFIG,
    token: "test-token",
    ...overrides,
    capture: { ...DEFAULT_CONFIG.capture, ...(overrides.capture ?? {}) },
    redaction: { ...DEFAULT_CONFIG.redaction, ...(overrides.redaction ?? {}) },
  }
}

async function setup(adapters?: readonly HostSeatAdapter[]) {
  const config = makeConfig()
  const store = new Store({ path: ":memory:", retentionDays: config.retentionDays })
  const changes: Change[] = []
  const pipeline = new Pipeline({ store, config, onChanges: (batch) => changes.push(...batch) })
  const app = await createServer({
    store,
    pipeline,
    config,
    broadcaster: new Broadcaster(),
    diagnostics: new Diagnostics(),
    webDir: "/nonexistent",
    ...(adapters === undefined ? {} : { adapters }),
  })
  closers.push(() => {
    void app.close()
    store.close()
  })
  return app
}

function auth() {
  return { authorization: "Bearer test-token" }
}

const CAPABILITIES: HostCapabilities = {
  discovery: "cached",
  childModel: "supported",
  childReasoning: "supported",
  requiresReload: true,
}

interface FakeOptions {
  kind: HostSeatAdapter["kind"]
  label?: string
  profiles?: HostProfile[]
  catalogue?: (profileId: string) => ModelCatalogue
  capabilities?: HostCapabilities
  /** Incremented every time `catalogue()` is reached. */
  calls?: { catalogue: number }
}

function fakeAdapter(options: FakeOptions): HostSeatAdapter {
  const profiles = options.profiles ?? [{ id: `${options.kind}:default`, host: options.kind, label: options.label ?? options.kind }]
  return {
    kind: options.kind,
    label: options.label ?? options.kind,
    profiles: () => profiles.map((profile) => ({ ...profile })),
    catalogue(profileId: string): ModelCatalogue {
      if (options.calls) options.calls.catalogue += 1
      if (options.catalogue) return options.catalogue(profileId)
      return {
        models: [
          {
            id: "acme/big",
            label: "Acme Big",
            contextWindow: 200_000,
            options: [
              {
                id: "variant",
                label: "Reasoning effort",
                type: "select",
                choices: [
                  { id: "low", label: "low" },
                  { id: "high", label: "high", isDefault: true },
                ],
                currentValue: "high",
              },
              { id: "thinking", label: "Extended thinking", type: "boolean" },
            ],
          },
        ],
        source: `fake catalogue for ${profileId}`,
        freshness: "cached",
        warnings: [],
      }
    },
    diagnose: () => [],
    capabilities: () => options.capabilities ?? CAPABILITIES,
  }
}

/** A host whose CLI is simply not on this machine. A normal, expected state. */
function missingBinaryAdapter(calls?: { catalogue: number }): HostSeatAdapter {
  return fakeAdapter({
    kind: "codex",
    label: "Codex",
    calls,
    capabilities: { discovery: "live", childModel: "experimental", childReasoning: "experimental", requiresReload: false },
    catalogue: () => ({
      models: [],
      source: "codex app-server model/list",
      freshness: "unknown",
      warnings: ["Observer could not start codex. It may not be installed on this machine."],
    }),
  })
}

/** A host whose adapter is broken in every direction at once. */
function explodingAdapter(): HostSeatAdapter {
  return {
    kind: "claude",
    label: "Claude Code",
    profiles: () => {
      throw new Error("ENOENT: no home directory, open '/root/.claude' token=sk-should-never-surface")
    },
    catalogue: () => {
      throw new Error("spawn failed: token=sk-should-never-surface")
    },
    diagnose: () => [],
    capabilities: () => {
      throw new Error("capabilities unavailable")
    },
  }
}

describe("GET /v1/hosts", () => {
  it("requires the token", async () => {
    const app = await setup([fakeAdapter({ kind: "opencode" })])
    expect((await app.inject({ method: "GET", url: "/v1/hosts" })).statusCode).toBe(401)
  })

  it("reports label, profiles and capabilities per host, in registration order", async () => {
    const app = await setup([
      fakeAdapter({
        kind: "opencode",
        label: "OpenCode",
        profiles: [{ id: "opencode:default", host: "opencode", label: "OpenCode", binaryPath: "/usr/bin/opencode", homePath: "/home/u/.opencode" }],
      }),
      missingBinaryAdapter(),
    ])

    const response = await app.inject({ method: "GET", url: "/v1/hosts", headers: auth() })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { hosts: Array<Record<string, unknown>> }

    expect(body.hosts.map((host) => host["id"])).toEqual(["opencode", "codex"])
    expect(body.hosts[0]).toEqual({
      id: "opencode",
      label: "OpenCode",
      profiles: [
        {
          id: "opencode:default",
          host: "opencode",
          label: "OpenCode",
          binaryPath: "/usr/bin/opencode",
          homePath: "/home/u/.opencode",
        },
      ],
      capabilities: { discovery: "cached", childModel: "supported", childReasoning: "supported", requiresReload: true },
      warnings: [],
    })
    // The reason the field exists: two hosts, two different honest answers.
    expect(body.hosts[1]?.["capabilities"]).toEqual({
      discovery: "live",
      childModel: "experimental",
      childReasoning: "experimental",
      requiresReload: false,
    })
  })

  it("never asks a host for its catalogue", async () => {
    // The index must stay spawn-free. A picker's first paint on a laptop with
    // no Codex installed should not wait on a process that is not there.
    const calls = { catalogue: 0 }
    const app = await setup([fakeAdapter({ kind: "opencode", calls }), missingBinaryAdapter(calls)])
    expect((await app.inject({ method: "GET", url: "/v1/hosts", headers: auth() })).statusCode).toBe(200)
    expect(calls.catalogue).toBe(0)
  })

  it("contains one broken adapter without losing the others", async () => {
    const app = await setup([explodingAdapter(), fakeAdapter({ kind: "opencode", label: "OpenCode" })])

    const response = await app.inject({ method: "GET", url: "/v1/hosts", headers: auth() })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { hosts: Array<Record<string, unknown>> }
    expect(body.hosts).toHaveLength(2)

    const broken = body.hosts[0] as { profiles: unknown[]; capabilities: unknown; warnings: string[] }
    expect(broken.profiles).toEqual([])
    // Null, not a fabricated all-`unsupported` block. "No adapter could answer"
    // and "an adapter looked and the host cannot do it" are different claims,
    // and only the second one is a finding.
    expect(broken.capabilities).toBeNull()
    expect(broken.warnings).toHaveLength(2)
    // The thrown value never reaches the wire.
    expect(JSON.stringify(body)).not.toContain("sk-should-never-surface")
    expect(JSON.stringify(body)).not.toContain("ENOENT")

    expect(body.hosts[1]?.["label"]).toBe("OpenCode")
    expect(body.hosts[1]?.["warnings"]).toEqual([])
  })

  it("enumerates the shipped registry when no adapters are injected", async () => {
    const app = await setup()
    const response = await app.inject({ method: "GET", url: "/v1/hosts", headers: auth() })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { hosts: Array<{ id: string; capabilities: HostCapabilities | null }> }
    expect(body.hosts.map((host) => host.id)).toEqual(["opencode", "codex", "claude", "copilot"])
    for (const host of body.hosts) expect(host.capabilities, host.id).not.toBeNull()
  })
})

describe("GET /v1/hosts/:host/models", () => {
  it("requires the token", async () => {
    const app = await setup([fakeAdapter({ kind: "opencode" })])
    expect((await app.inject({ method: "GET", url: "/v1/hosts/opencode/models" })).statusCode).toBe(401)
  })

  it("serves the catalogue with option descriptors the UI can render", async () => {
    const app = await setup([fakeAdapter({ kind: "opencode", label: "OpenCode" })])
    const response = await app.inject({ method: "GET", url: "/v1/hosts/opencode/models", headers: auth() })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      host: "opencode",
      label: "OpenCode",
      profile: "opencode:default",
      models: [
        {
          id: "acme/big",
          label: "Acme Big",
          contextWindow: 200_000,
          options: [
            {
              id: "variant",
              label: "Reasoning effort",
              type: "select",
              choices: [
                { id: "low", label: "low" },
                { id: "high", label: "high", isDefault: true },
              ],
              currentValue: "high",
            },
            { id: "thinking", label: "Extended thinking", type: "boolean" },
          ],
        },
      ],
      source: "fake catalogue for opencode:default",
      freshness: "cached",
      warnings: [],
    })
  })

  it("passes ?profile through and echoes the profile it answered for", async () => {
    const app = await setup([
      fakeAdapter({
        kind: "codex",
        profiles: [
          { id: "codex:work", host: "codex", label: "Codex (work)" },
          { id: "codex:personal", host: "codex", label: "Codex (personal)" },
        ],
      }),
    ])

    const first = await app.inject({ method: "GET", url: "/v1/hosts/codex/models", headers: auth() })
    expect(first.json()["profile"]).toBe("codex:work")

    const second = await app.inject({ method: "GET", url: "/v1/hosts/codex/models?profile=codex:personal", headers: auth() })
    expect(second.json()["profile"]).toBe("codex:personal")
    expect(second.json()["source"]).toBe("fake catalogue for codex:personal")

    // An empty value is "unspecified", not a bad request: a picker with nothing
    // selected yet gets the default profile's list.
    const empty = await app.inject({ method: "GET", url: "/v1/hosts/codex/models?profile=", headers: auth() })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()["profile"]).toBe("codex:work")
  })

  it("rejects a malformed profile query", async () => {
    const app = await setup([fakeAdapter({ kind: "codex" })])
    const response = await app.inject({ method: "GET", url: "/v1/hosts/codex/models?profile=a&profile=b", headers: auth() })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: "invalid host models query" })
  })

  it("answers a host whose binary is missing with an empty list and the reason", async () => {
    // Not an error. On a machine where the user only installed one of these
    // tools this is the correct, expected answer for all the others.
    const app = await setup([missingBinaryAdapter()])
    const response = await app.inject({ method: "GET", url: "/v1/hosts/codex/models", headers: auth() })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { models: unknown[]; freshness: string; warnings: string[] }
    expect(body.models).toEqual([])
    expect(body.freshness).toBe("unknown")
    expect(body.warnings).toEqual(["Observer could not start codex. It may not be installed on this machine."])
  })

  it("turns an adapter that throws into a warning, never a 500", async () => {
    const app = await setup([explodingAdapter()])
    const response = await app.inject({ method: "GET", url: "/v1/hosts/claude/models", headers: auth() })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { profile: string; models: unknown[]; source: string; freshness: string; warnings: string[] }
    expect(body.models).toEqual([])
    expect(body.profile).toBe("")
    expect(body.source).toBe("unavailable")
    expect(body.freshness).toBe("unknown")
    expect(body.warnings).toHaveLength(2)
    expect(body.warnings[1]).toContain("may not be installed")
    // Whatever the adapter was holding when it died stays off the wire.
    expect(response.body).not.toContain("sk-should-never-surface")
  })

  it("404s an unknown host instead of guessing", async () => {
    const app = await setup([fakeAdapter({ kind: "opencode" })])
    for (const host of ["cursor", "openkode", "codex"]) {
      const response = await app.inject({ method: "GET", url: `/v1/hosts/${host}/models`, headers: auth() })
      expect(response.statusCode, host).toBe(404)
      expect(response.json(), host).toEqual({ error: "unknown host" })
    }
  })

  it("404s a prototype-pollution style host id", async () => {
    // The path segment is user input. An object literal keyed by host would
    // answer `toString` with a function; the lookup is a Map for exactly this.
    const app = await setup([fakeAdapter({ kind: "opencode" })])
    for (const host of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      const response = await app.inject({ method: "GET", url: `/v1/hosts/${host}/models`, headers: auth() })
      expect(response.statusCode, host).toBe(404)
      expect(response.json(), host).toEqual({ error: "unknown host" })
    }
  })

  it("keeps a healthy host answering after a broken one has failed", async () => {
    // The containment property stated as an incident would: one bad host does
    // not degrade the next request for a good one.
    const app = await setup([explodingAdapter(), fakeAdapter({ kind: "opencode", label: "OpenCode" })])
    expect((await app.inject({ method: "GET", url: "/v1/hosts/claude/models", headers: auth() })).statusCode).toBe(200)
    const healthy = await app.inject({ method: "GET", url: "/v1/hosts/opencode/models", headers: auth() })
    expect(healthy.statusCode).toBe(200)
    expect((healthy.json() as { models: unknown[] }).models).toHaveLength(1)
  })
})

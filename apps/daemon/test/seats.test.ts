import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ROSTER, behaviorDirective } from "@observer-ai/roster"
import { loadConfig, saveConfig } from "@observer-ai/daemon"
// Straight from source, not from the package barrel: `apps/daemon` resolves to
// `dist`, and the target contracts are not re-exported from `index.ts` yet
// (ticket 02 owns that file). Importing the built copy would silently test
// whatever was last compiled.
import {
  DEFAULT_SEATS,
  LEGACY_TARGET_ID,
  SEAT_VARIANTS,
  SeatsConfigSchema,
  applySeatSkills,
  diagnoseOpencodeModel,
  diagnoseSeats,
  isOpencodeModelId,
  migrateSeatSpecToTargets,
  seatFor,
  seatTargetPath,
  seatTargets,
} from "../src/seats.js"
import type { SeatFinding, SeatIssueCode, SeatSpec, SeatTarget, SeatsConfig } from "../src/seats.js"
import { HOST_KINDS, ProviderInstanceConfigSchema, ProvidersConfigSchema, isHostKind } from "../src/providers.js"
import { createOpencodeAdapter } from "../src/adapters/opencode.js"

/** Parses a seats section the way `loadConfig` does, from raw JSON. */
function parseSeats(raw: unknown): SeatsConfig {
  return SeatsConfigSchema.parse(raw) as SeatsConfig
}

function codes(seats: SeatsConfig): SeatIssueCode[] {
  return diagnoseSeats(seats).issues.map((issue) => issue.code)
}

const REAL_ID = "arjun-mehta"

describe("seat spec schema", () => {
  it("defaults to control off and nobody seated", () => {
    expect(parseSeats(undefined)).toEqual({ control: false, employees: {} })
    expect(DEFAULT_SEATS).toEqual({ control: false, employees: {} })
  })

  it("accepts a fully specified seat", () => {
    const seats = parseSeats({
      control: true,
      employees: { [REAL_ID]: { model: "anthropic/claude-opus-4-5", variant: "high", skills: ["react"] } },
    })
    expect(seats.control).toBe(true)
    expect(seats.employees[REAL_ID]).toMatchObject({ model: "anthropic/claude-opus-4-5", variant: "high" })
  })

  it("canonicalises a bare skill name into an EmployeeSkill", () => {
    const seats = parseSeats({ control: false, employees: { [REAL_ID]: { skills: ["react", { name: "rsc", description: "server components" }] } } })
    expect(seats.employees[REAL_ID]?.skills).toEqual([
      { name: "react", description: "" },
      { name: "rsc", description: "server components" },
    ])
  })

  it("keeps every other field when one field of a seat is malformed", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: 5, variant: "high" } } })
    expect(seats.employees[REAL_ID]?.model).toBeUndefined()
    expect(seats.employees[REAL_ID]?.variant).toBe("high")
  })

  it("keeps every other employee when one employee's seat is unusable", () => {
    const seats = parseSeats({
      control: true,
      employees: { [REAL_ID]: "opus", "malik-johnson": { model: "anthropic/claude-opus-4-5" } },
    })
    expect(seats.employees["malik-johnson"]?.model).toBe("anthropic/claude-opus-4-5")
    expect(seats.employees[REAL_ID]).toEqual({})
  })

  it("falls back a garbage control flag rather than failing the section", () => {
    const seats = parseSeats({ control: "yes", employees: { [REAL_ID]: { model: "anthropic/x" } } })
    expect(seats.control).toBe(false)
    expect(seats.employees[REAL_ID]?.model).toBe("anthropic/x")
  })

  it("accepts a variant outside the suggested set, because models declare their own", () => {
    // The host validates a variant against the model's own list, which grows
    // with models.dev. A stale enum here would reject a value that works.
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "a/b", variant: "ultra" } } })
    expect(seats.employees[REAL_ID]?.variant).toBe("ultra")
  })

  it("keeps a seat field Observer does not apply yet", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "a/b", temperature: 0.2 } } })
    expect(seats.employees[REAL_ID]?.["temperature"]).toBe(0.2)
  })

  it("offers the seven effort levels weakest first", () => {
    expect(SEAT_VARIANTS).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
  })
})

describe("diagnoseSeats", () => {
  it("returns no findings for an empty config", () => {
    const diagnosis = diagnoseSeats(DEFAULT_SEATS)
    expect(diagnosis.issues).toEqual([])
    expect(diagnosis.ok).toBe(true)
    expect(diagnosis.effective).toBe(false)
  })

  it("reports a variant set with no model as having no effect", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { variant: "high" } } })
    const issue = diagnoseSeats(seats).issues.find((entry) => entry.code === "variant-without-model")
    expect(issue?.severity).toBe("warning")
    expect(issue?.path).toBe(`seats.employees.${REAL_ID}.variant`)
    expect(issue?.employeeId).toBe(REAL_ID)
    expect(issue?.message).toContain("no effect")
  })

  it("does not report variant-without-model once a model is set", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "anthropic/x", variant: "high" } } })
    expect(codes(seats)).not.toContain("variant-without-model")
  })

  it("errors on an employee id that is not on the roster, without dropping it", () => {
    const seats = parseSeats({ control: true, employees: { "arjun-metha": { model: "anthropic/x" } } })
    const diagnosis = diagnoseSeats(seats)
    expect(diagnosis.ok).toBe(false)
    expect(diagnosis.issues[0]?.code).toBe("unknown-employee")
    expect(seats.employees["arjun-metha"]).toBeDefined()
  })

  it("accepts every real roster id without complaint", () => {
    const employees = Object.fromEntries(ROSTER.map((profile) => [profile.id, { model: "anthropic/x" }]))
    const seats = parseSeats({ control: true, employees })
    expect(diagnoseSeats(seats).issues).toEqual([])
  })

  it("no longer applies OpenCode's slash rule to every host", () => {
    // The rule moved to `diagnoseOpencodeModel`. Shared diagnosis cannot know
    // which host a bare `model` was written for, and Codex and Grok model ids
    // legitimately carry no slash.
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "claude-opus-4-5" } } })
    expect(diagnoseSeats(seats).ok).toBe(true)
    expect(codes(seats)).not.toContain("malformed-model")
  })

  it("warns on an unrecognised effort but does not call it an error", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "anthropic/x", variant: "ultra" } } })
    const diagnosis = diagnoseSeats(seats)
    expect(diagnosis.ok).toBe(true)
    expect(codes(seats)).toContain("unrecognised-variant")
  })

  it("stays quiet about the models that grade effort as none/default", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "anthropic/x", variant: "default" } } })
    expect(codes(seats)).not.toContain("unrecognised-variant")
  })

  it("notes a field Observer preserves but does not apply", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "anthropic/x", top_p: 0.9 } } })
    const issue = diagnoseSeats(seats).issues.find((entry) => entry.code === "unknown-field")
    expect(issue?.severity).toBe("info")
    expect(issue?.path).toBe(`seats.employees.${REAL_ID}.top_p`)
  })

  it("notes a seat that sets nothing", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: {} } })
    expect(codes(seats)).toContain("empty-seat")
  })

  it("says plainly that models are inert while control is off, but skills are not", () => {
    const seats = parseSeats({ control: false, employees: { [REAL_ID]: { model: "anthropic/x" } } })
    const issue = diagnoseSeats(seats).issues.find((entry) => entry.code === "control-disabled")
    expect(issue?.severity).toBe("info")
    expect(issue?.path).toBe("seats.control")
    expect(issue?.message).toContain("Skills still apply")
  })

  it("does not claim a model is in effect while control is off", () => {
    const seats = parseSeats({ control: false, employees: { [REAL_ID]: { model: "anthropic/x" } } })
    expect(diagnoseSeats(seats).effective).toBe(false)
  })

  it("counts a config as effective once control is on and a model is set", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "anthropic/x" } } })
    expect(diagnoseSeats(seats).effective).toBe(true)
  })

  it("counts skills as effective even with control off, because they are only prompt text", () => {
    const seats = parseSeats({ control: false, employees: { [REAL_ID]: { skills: ["react"] } } })
    expect(diagnoseSeats(seats).effective).toBe(true)
    expect(codes(seats)).not.toContain("control-disabled")
  })

  it("throws on nothing it is handed", () => {
    const hostile = { control: true, employees: { "": {}, "arjun-mehta": { model: "", variant: "" } } } as unknown as SeatsConfig
    expect(() => diagnoseSeats(hostile)).not.toThrow()
  })
})

describe("seatFor", () => {
  it("returns the seat for a real employee", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "anthropic/x" } } })
    expect(seatFor(seats, REAL_ID)?.model).toBe("anthropic/x")
  })

  it("returns undefined for an id that is not on the roster, so a typo cannot be acted on", () => {
    const seats = parseSeats({ control: true, employees: { "arjun-metha": { model: "anthropic/x" } } })
    expect(seatFor(seats, "arjun-metha")).toBeUndefined()
  })
})

describe("applySeatSkills", () => {
  const profile = ROSTER.find((entry) => entry.id === REAL_ID)!

  it("returns the profile untouched when nothing is configured", () => {
    expect(applySeatSkills(profile, DEFAULT_SEATS)).toBe(profile)
  })

  it("folds configured skills into a profile that ships none", () => {
    const seats = parseSeats({ control: false, employees: { [REAL_ID]: { skills: ["react", "rsc"] } } })
    const merged = applySeatSkills(profile, seats)
    expect(merged.skills.map((skill) => skill.name)).toEqual(["react", "rsc"])
    // The roster stays a pure data package: the source profile is not mutated.
    expect(profile.skills).toEqual([])
  })

  it("lights up the skills line behaviorDirective already renders", () => {
    const seats = parseSeats({ control: false, employees: { [REAL_ID]: { skills: ["react"] } } })
    expect(behaviorDirective(profile, "build a form")).not.toContain("Skills available to you")
    expect(behaviorDirective(applySeatSkills(profile, seats), "build a form")).toContain("Skills available to you: react.")
  })

  it("does not duplicate a skill the profile already has", () => {
    const withSkill = { ...profile, skills: [{ name: "React", description: "existing" }] }
    const seats = parseSeats({ control: false, employees: { [REAL_ID]: { skills: ["react", "rsc"] } } })
    expect(applySeatSkills(withSkill, seats).skills.map((skill) => skill.name)).toEqual(["React", "rsc"])
  })

  it("ignores skills filed under an id that is not on the roster", () => {
    const seats = parseSeats({ control: false, employees: { "arjun-metha": { skills: ["react"] } } })
    expect(applySeatSkills(profile, seats)).toBe(profile)
  })
})

describe("seats survive the config round-trip", () => {
  let home: string
  let originalHome: string | undefined

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "observer-seats-"))
    originalHome = process.env["OBSERVER_HOME"]
    process.env["OBSERVER_HOME"] = home
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env["OBSERVER_HOME"]
    else process.env["OBSERVER_HOME"] = originalHome
    rmSync(home, { recursive: true, force: true })
  })

  it("keeps an unknown employee id and an unapplied field through a save", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        port: 4599,
        token: "tok",
        seats: { control: true, employees: { "arjun-metha": { model: "anthropic/x", temperature: 0.2 } } },
      }),
    )
    saveConfig(loadConfig())
    const written = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
    expect(written.seats.employees["arjun-metha"]).toEqual({ model: "anthropic/x", temperature: 0.2 })
  })

  it("writes a seats section on first run so the shape is discoverable", () => {
    loadConfig()
    const written = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
    expect(written.seats).toEqual({ control: false, employees: {} })
  })

  it("gives a real legacy config back byte for byte, model and variant included", () => {
    // The shape actually on disk right now: five employees with the legacy
    // pair plus one model-only. A load that migrated would rewrite a file the
    // user never asked to change, and would strand a rollback to a build that
    // only reads `model`.
    //
    // Compared as the whole file, not just `seats.employees`. The earlier
    // version of this test called itself byte-for-byte while checking one
    // subtree, so it would have passed while a no-op save added, dropped or
    // reordered an unrelated top-level key.
    const employees: Record<string, unknown> = Object.fromEntries(
      ROSTER.slice(0, 5).map((profile, index) => [profile.id, { model: `anthropic/m-${index}`, variant: "high" }]),
    )
    employees[ROSTER[5]!.id] = { model: "anthropic/m-5" }
    const config = {
      port: 4599,
      token: "tok",
      retentionDays: 30,
      redaction: { enabled: true, maxTextLength: 64000 },
      capture: { messages: true, reasoning: true, toolInput: true, toolOutput: true, prompts: true, rawEvents: false },
      guidance: true,
      seats: { control: true, employees },
      providers: {},
      autostart: true,
    }
    const original = `${JSON.stringify(config, null, 2)}\n`
    writeFileSync(join(home, "config.json"), original)
    const loaded = loadConfig()
    saveConfig(loaded)
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(original)
    expect(diagnoseSeats(loaded.seats as SeatsConfig).issues).toEqual([])
    expect(diagnoseSeats(loaded.seats as SeatsConfig).ok).toBe(true)
  })

  it("keeps a targets map, its option values and its unknown keys through a save", () => {
    const targets = {
      "codex:default": { host: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
      "claude:default": { host: "claude", model: "claude-opus-4-8", options: [{ id: "thinking", value: true }], sandbox: "danger" },
    }
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ port: 4599, token: "tok", seats: { control: true, employees: { [REAL_ID]: { targets } } } }),
    )
    saveConfig(loadConfig())
    const written = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
    expect(written.seats.employees[REAL_ID].targets).toEqual(targets)
  })

  it("round-trips a targets value that is not a map", () => {
    const seats = { control: true, employees: { [REAL_ID]: { model: "a/b", targets: "sentinel" } } }
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 4599, token: "tok", seats }))
    saveConfig(loadConfig())
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).seats).toEqual(seats)
  })

  it("round-trips a target entry that is not a target, alongside one that is", () => {
    const employees = {
      [REAL_ID]: { targets: { bad: 7, worse: "opus", "grok:default": { host: "grok", model: "grok-build" } } },
    }
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 4599, token: "tok", seats: { control: true, employees } }))
    saveConfig(loadConfig())
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).seats.employees).toEqual(employees)
  })

  it("round-trips an option carrying an unknown key and one with an unusable value", () => {
    const employees = {
      [REAL_ID]: {
        targets: {
          "cursor:default": {
            host: "cursor",
            model: "composer-2",
            options: [{ id: "x", value: "high", future: 42 }, { id: "y", value: { nested: true } }],
          },
        },
      },
    }
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 4599, token: "tok", seats: { control: true, employees } }))
    saveConfig(loadConfig())
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).seats.employees).toEqual(employees)
  })

  it("round-trips a provider entry whose driver is the wrong type, siblings included", () => {
    const providers = { local: { driver: 42, displayName: "Local", binaryPath: "/x", note: "keep" } }
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 4599, token: "tok", providers }))
    saveConfig(loadConfig())
    const written = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
    expect(written.providers.local).toEqual({ driver: "", displayName: "Local", binaryPath: "/x", note: "keep", enabled: true })
  })
})

describe("diagnoseSeats reports instead of throwing", () => {
  it("survives a half-typed config the way a TUI would hand it over", () => {
    const partial = { control: true } as unknown as SeatsConfig
    expect(() => diagnoseSeats(partial)).not.toThrow()
    expect(diagnoseSeats(partial).issues).toEqual([])
  })

  it("survives a null seat without losing the employees around it", () => {
    const hostile = {
      control: true,
      employees: { [REAL_ID]: null, "malik-johnson": { model: "anthropic/x" } },
    } as unknown as SeatsConfig
    expect(() => diagnoseSeats(hostile)).not.toThrow()
    expect(codes(hostile)).toContain("empty-seat")
    expect(diagnoseSeats(hostile).effective).toBe(true)
  })

  it("survives a target that is not an object", () => {
    const hostile = {
      control: true,
      employees: { [REAL_ID]: { targets: { "opencode:default": "opus" } } },
    } as unknown as SeatsConfig
    expect(() => diagnoseSeats(hostile)).not.toThrow()
    // `malformed-target` and not `unknown-host`: a string has no host to be
    // wrong about, and two rows for one mistake is what the adapter contract
    // exists to prevent.
    expect(codes(hostile)).toEqual(["malformed-target"])
  })

  it("survives targets handed over as an array", () => {
    const hostile = { control: true, employees: { [REAL_ID]: { targets: [] } } } as unknown as SeatsConfig
    expect(() => diagnoseSeats(hostile)).not.toThrow()
    expect(seatTargets(hostile.employees[REAL_ID] as SeatSpec)).toEqual({})
  })
})

describe("provider instance schema", () => {
  function parseProvider(raw: unknown): Record<string, unknown> {
    return ProviderInstanceConfigSchema.parse(raw) as Record<string, unknown>
  }

  it("keeps every valid sibling when the driver is the wrong type", () => {
    // The exact regression: this used to hit the object-level catch and come
    // back `{}`, so a mistyped driver silently ate the binary path the user
    // had spent ten minutes finding.
    expect(parseProvider({ driver: 42, displayName: "Local", binaryPath: "/x", note: "keep" })).toEqual({
      driver: "",
      displayName: "Local",
      binaryPath: "/x",
      note: "keep",
      enabled: true,
    })
  })

  it("empties a driver it cannot read rather than inventing one", () => {
    // `/v1/providers/status` gates on `driver.length > 0`, so an empty driver
    // is a value a caller can see and refuse.
    expect(parseProvider({ driver: "" })["driver"]).toBe("")
    expect(parseProvider({ driver: null })["driver"]).toBe("")
    expect(parseProvider({ driver: "codex" })["driver"]).toBe("codex")
  })

  it("keeps a whole entry that is not an object at all", () => {
    expect(ProviderInstanceConfigSchema.parse("codex")).toBe("codex")
    expect(ProviderInstanceConfigSchema.parse(7)).toBe(7)
  })

  it("keeps the other entries when one of them is unusable", () => {
    const parsed = ProvidersConfigSchema.parse({ broken: 7, work: { driver: "codex", homePath: "/h" } }) as Record<string, unknown>
    expect(parsed["broken"]).toBe(7)
    expect(parsed["work"]).toEqual({ driver: "codex", homePath: "/h", enabled: true })
  })

  it("falls back one bad path without touching the other", () => {
    expect(parseProvider({ driver: "codex", binaryPath: 5, homePath: "/h" })).toEqual({
      driver: "codex",
      homePath: "/h",
      enabled: true,
    })
  })
})

describe("host kinds", () => {
  it("names every CLI Observer drives", () => {
    // Copilot is here because it is a first-class Observer host everywhere else
    // — it has an event adapter, a hook installer and a `HOST_CAPABILITIES`
    // entry — and its absence from this tuple was an oversight that made
    // `diagnoseSeats` report a working Copilot target as `unknown-host`.
    expect([...HOST_KINDS].sort()).toEqual(["claude", "codex", "copilot", "cursor", "grok", "opencode"])
  })

  it("recognises a host by name and rejects anything else", () => {
    expect(isHostKind("codex")).toBe(true)
    expect(isHostKind("copilot")).toBe(true)
    expect(isHostKind("Codex")).toBe(false)
    expect(isHostKind("kilocode")).toBe(false)
  })
})

describe("seat target schema", () => {
  it("accepts a fully specified target", () => {
    const seats = parseSeats({
      control: true,
      employees: {
        [REAL_ID]: {
          targets: {
            "codex:default": { host: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
          },
        },
      },
    })
    expect(seats.employees[REAL_ID]?.targets?.["codex:default"]).toEqual({
      host: "codex",
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    })
  })

  it("takes a boolean option value as readily as a string one", () => {
    const seats = parseSeats({
      control: true,
      employees: { [REAL_ID]: { targets: { "claude:default": { host: "claude", model: "opus", options: [{ id: "thinking", value: true }] } } } },
    })
    expect(seats.employees[REAL_ID]?.targets?.["claude:default"]?.options).toEqual([{ id: "thinking", value: true }])
  })

  it("keeps a malformed option in place rather than dropping it or the list", () => {
    // Losing every Cursor option because one value was typed as a number is
    // the failure the per-element parse exists to prevent. Losing just the
    // mistyped one is the same failure one step down: the user opens the
    // editor to fix a typo and there is nothing left to fix.
    const seats = parseSeats({
      control: true,
      employees: {
        [REAL_ID]: {
          targets: {
            "cursor:default": {
              host: "cursor",
              model: "composer-2",
              options: [{ id: "a", value: "high" }, { id: "b", value: 5 }, { id: "", value: "x" }, { id: "c", value: false }],
            },
          },
        },
      },
    })
    expect(seats.employees[REAL_ID]?.targets?.["cursor:default"]?.options).toEqual([
      { id: "a", value: "high" },
      { id: "b", value: 5 },
      { id: "", value: "x" },
      { id: "c", value: false },
    ])
  })

  it("keeps an unknown key on an option", () => {
    const seats = parseSeats({
      control: true,
      employees: {
        [REAL_ID]: {
          targets: { "claude:default": { host: "claude", model: "opus", options: [{ id: "x", value: "high", future: 42 }] } },
        },
      },
    })
    expect(seats.employees[REAL_ID]?.targets?.["claude:default"]?.options).toEqual([{ id: "x", value: "high", future: 42 }])
  })

  it("keeps a targets value that is not a map at all", () => {
    // Before `targets` was a declared field the surrounding `.passthrough()`
    // kept this. Declaring a field must never be the thing that makes a
    // previously safe config lossy.
    for (const sentinel of ["sentinel", 7, [], null]) {
      const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "a/b", targets: sentinel } } })
      expect(seats.employees[REAL_ID]?.targets).toEqual(sentinel)
      expect(seats.employees[REAL_ID]?.model).toBe("a/b")
    }
  })

  it("keeps an unrecognised host verbatim so the user can see their typo", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { targets: { t: { host: "openkode", model: "a/b" } } } } })
    expect(seats.employees[REAL_ID]?.targets?.["t"]?.host).toBe("openkode")
  })

  it("keeps a target key Observer does not understand", () => {
    const seats = parseSeats({
      control: true,
      employees: { [REAL_ID]: { targets: { "grok:default": { host: "grok", model: "grok-build", sandbox: "danger" } } } },
    })
    expect(seats.employees[REAL_ID]?.targets?.["grok:default"]?.["sandbox"]).toBe("danger")
  })

  it("keeps the other targets when one of them is unusable, and the unusable one verbatim", () => {
    // The original version of this test asserted `{ host: "" }` here. That
    // encoded the bug: the substituted shape threw the user's `7` away and
    // then produced a finding about a host the entry never had.
    const seats = parseSeats({
      control: true,
      employees: { [REAL_ID]: { targets: { bad: 7, "grok:default": { host: "grok", model: "grok-build" } } } },
    })
    expect(seats.employees[REAL_ID]?.targets?.["grok:default"]?.model).toBe("grok-build")
    expect(seats.employees[REAL_ID]?.targets?.["bad"]).toBe(7)
  })

  it("keeps the rest of a target when its model is malformed", () => {
    const seats = parseSeats({
      control: true,
      employees: { [REAL_ID]: { targets: { t: { host: "codex", model: 5, options: [{ id: "reasoningEffort", value: "high" }] } } } },
    })
    expect(seats.employees[REAL_ID]?.targets?.["t"]?.model).toBeUndefined()
    expect(seats.employees[REAL_ID]?.targets?.["t"]?.options).toEqual([{ id: "reasoningEffort", value: "high" }])
  })

  it("tells an absent targets map apart from an empty one", () => {
    // Absent is what every config written before targets existed has, and it
    // is the signal the legacy fallback keys on.
    const legacy = parseSeats({ control: true, employees: { [REAL_ID]: { model: "anthropic/x" } } })
    const explicit = parseSeats({ control: true, employees: { [REAL_ID]: { model: "anthropic/x", targets: {} } } })
    expect(legacy.employees[REAL_ID]?.targets).toBeUndefined()
    expect(explicit.employees[REAL_ID]?.targets).toEqual({})
    expect(seatTargets(legacy.employees[REAL_ID])).not.toEqual({})
    expect(seatTargets(explicit.employees[REAL_ID])).toEqual({})
  })
})

describe("seatTargets reads legacy model and variant as an opencode target", () => {
  it("derives an opencode:default target from model and variant", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "anthropic/claude-opus-4-5", variant: "high" } } })
    expect(seatTargets(seats.employees[REAL_ID])).toEqual({
      [LEGACY_TARGET_ID]: {
        host: "opencode",
        model: "anthropic/claude-opus-4-5",
        options: [{ id: "variant", value: "high" }],
      },
    })
  })

  it("derives a model-only target with no options", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "anthropic/x" } } })
    expect(seatTargets(seats.employees[REAL_ID])).toEqual({ [LEGACY_TARGET_ID]: { host: "opencode", model: "anthropic/x" } })
  })

  it("derives nothing from a seat that only sets skills", () => {
    const seats = parseSeats({ control: false, employees: { [REAL_ID]: { skills: ["react"] } } })
    expect(seatTargets(seats.employees[REAL_ID])).toEqual({})
  })

  it("lets explicit targets outrank a stale legacy model", () => {
    const seats = parseSeats({
      control: true,
      employees: { [REAL_ID]: { model: "anthropic/old", targets: { "codex:default": { host: "codex", model: "gpt-5.6-sol" } } } },
    })
    expect(seatTargets(seats.employees[REAL_ID])).toEqual({ "codex:default": { host: "codex", model: "gpt-5.6-sol" } })
  })

  it("hands back a copy, so a caller cannot edit the config through it", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { targets: { t: { host: "codex" } } } } })
    const targets = seatTargets(seats.employees[REAL_ID])
    delete targets["t"]
    expect(seats.employees[REAL_ID]?.targets?.["t"]).toBeDefined()
  })

  it("answers for anything it is handed", () => {
    expect(seatTargets(undefined)).toEqual({})
    expect(seatTargets({} as SeatSpec)).toEqual({})
    expect(seatTargets({ model: "" } as SeatSpec)).toEqual({})
  })
})

describe("loading never drops the legacy fields", () => {
  it("keeps model and variant on the seat after a parse", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "anthropic/x", variant: "high" } } })
    expect(seats.employees[REAL_ID]).toEqual({ model: "anthropic/x", variant: "high" })
  })

  it("drops them only when migration writes targets", () => {
    const spec = parseSeats({ control: true, employees: { [REAL_ID]: { model: "anthropic/x", variant: "high", top_p: 0.9 } } })
      .employees[REAL_ID]!
    const migrated = migrateSeatSpecToTargets(spec)
    expect(migrated.model).toBeUndefined()
    expect(migrated.variant).toBeUndefined()
    expect(migrated.targets).toEqual({
      [LEGACY_TARGET_ID]: { host: "opencode", model: "anthropic/x", options: [{ id: "variant", value: "high" }] },
    })
    // Unknown keys are the whole reason the index signature exists; a
    // migration that ate them would be worse than no migration.
    expect(migrated["top_p"]).toBe(0.9)
    // The source seat is untouched, so a failed save cannot half-migrate it.
    expect(spec.model).toBe("anthropic/x")
  })

  it("leaves a seat with nothing to migrate exactly as it was", () => {
    const spec: SeatSpec = { skills: [{ name: "react", description: "" }] }
    expect(migrateSeatSpecToTargets(spec)).toBe(spec)
  })

  it("leaves an already-migrated seat alone, legacy leftovers and all", () => {
    const spec: SeatSpec = { model: "anthropic/old", targets: { t: { host: "codex", model: "gpt-5.6-sol" } } }
    expect(migrateSeatSpecToTargets(spec)).toBe(spec)
  })
})

describe("diagnoseSeats on targets", () => {
  function withTarget(target: unknown, targetId = "t"): SeatsConfig {
    return parseSeats({ control: true, employees: { [REAL_ID]: { targets: { [targetId]: target } } } })
  }

  it("says nothing about a well formed target", () => {
    const seats = withTarget({ host: "codex", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] })
    expect(diagnoseSeats(seats).issues).toEqual([])
  })

  it("accepts a bare Grok model id without calling it malformed", () => {
    const seats = withTarget({ host: "grok", model: "grok-build" }, "grok:default")
    const diagnosis = diagnoseSeats(seats)
    expect(diagnosis.ok).toBe(true)
    expect(diagnosis.issues).toEqual([])
  })

  it("errors on a host Observer does not drive, and names the target", () => {
    const seats = withTarget({ host: "openkode", model: "a/b" }, "opencode:default")
    const diagnosis = diagnoseSeats(seats)
    expect(diagnosis.ok).toBe(false)
    const issue = diagnosis.issues.find((entry) => entry.code === "unknown-host")
    expect(issue?.severity).toBe("error")
    expect(issue?.path).toBe(`seats.employees.${REAL_ID}.targets.opencode:default.host`)
    expect(issue?.targetId).toBe("opencode:default")
    expect(issue?.host).toBe("openkode")
    expect(issue?.employeeId).toBe(REAL_ID)
    expect(issue?.message).toContain("opencode")
  })

  it("errors on a target that names no host at all", () => {
    const issue = diagnoseSeats(withTarget({ model: "a/b" })).issues.find((entry) => entry.code === "unknown-host")
    expect(issue?.message).toContain("names no host")
    expect(issue?.host).toBe("")
  })

  it("warns that options with no model do nothing", () => {
    const seats = withTarget({ host: "claude", options: [{ id: "effort", value: "high" }] })
    const issue = diagnoseSeats(seats).issues.find((entry) => entry.code === "options-without-model")
    expect(issue?.severity).toBe("warning")
    expect(issue?.path).toBe(`seats.employees.${REAL_ID}.targets.t.options`)
    expect(issue?.message).toContain(`Option "effort"`)
    expect(diagnoseSeats(seats).ok).toBe(true)
  })

  it("counts the options when there is more than one to name", () => {
    const seats = withTarget({ host: "claude", options: [{ id: "a", value: "1" }, { id: "b", value: true }] })
    const issue = diagnoseSeats(seats).issues.find((entry) => entry.code === "options-without-model")
    expect(issue?.message).toContain("These 2 options")
  })

  it("stays quiet about options once the target sets a model", () => {
    const seats = withTarget({ host: "claude", model: "claude-opus-4-8", options: [{ id: "effort", value: "high" }] })
    expect(codes(seats)).not.toContain("options-without-model")
  })

  it("notes a target that sets nothing", () => {
    const issue = diagnoseSeats(withTarget({ host: "codex" })).issues.find((entry) => entry.code === "empty-target")
    expect(issue?.severity).toBe("info")
    expect(issue?.path).toBe(`seats.employees.${REAL_ID}.targets.t`)
    expect(issue?.targetId).toBe("t")
  })

  it("does not call a seat empty just because its only content is a target", () => {
    expect(codes(withTarget({ host: "codex", model: "gpt-5.6-sol" }))).not.toContain("empty-seat")
  })

  it("still calls a seat with an empty targets map empty", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { targets: {} } } })
    expect(codes(seats)).toContain("empty-seat")
  })

  it("does not report targets as an unapplied field", () => {
    expect(codes(withTarget({ host: "codex", model: "gpt-5.6-sol" }))).not.toContain("unknown-field")
  })

  it("says plainly that legacy fields are shadowed once targets exist", () => {
    const seats = parseSeats({
      control: true,
      employees: { [REAL_ID]: { model: "anthropic/old", variant: "high", targets: { t: { host: "codex", model: "gpt-5.6-sol" } } } },
    })
    const issue = diagnoseSeats(seats).issues.find((entry) => entry.code === "legacy-fields-shadowed")
    expect(issue?.severity).toBe("info")
    expect(issue?.message).toContain("ignored")
    // The legacy warnings would only be noise on top of that, and pointing at
    // a dead field's effort level would send the user to fix the wrong line.
    expect(codes(seats)).not.toContain("variant-without-model")
    expect(codes(seats)).not.toContain("unrecognised-variant")
  })

  it("counts a target model as controllable, exactly once", () => {
    const seats = withTarget({ host: "codex", model: "gpt-5.6-sol" })
    expect(diagnoseSeats(seats).effective).toBe(true)
    const off = parseSeats({ control: false, employees: { [REAL_ID]: { targets: { t: { host: "codex", model: "gpt-5.6-sol" } } } } })
    const issue = diagnoseSeats(off).issues.find((entry) => entry.code === "control-disabled")
    expect(diagnoseSeats(off).effective).toBe(false)
    expect(issue?.message).toContain("1 employee ")
  })

  it("does not count a half-migrated seat twice", () => {
    const seats = parseSeats({
      control: false,
      employees: { [REAL_ID]: { model: "anthropic/old", targets: { t: { host: "codex", model: "gpt-5.6-sol" } } } },
    })
    const issue = diagnoseSeats(seats).issues.find((entry) => entry.code === "control-disabled")
    expect(issue?.message).toContain("1 employee ")
  })

  it("keeps reporting an unknown employee id alongside its targets", () => {
    const seats = parseSeats({ control: true, employees: { "arjun-metha": { targets: { t: { host: "codex" } } } } })
    expect(codes(seats)).toEqual(["unknown-employee", "empty-target"])
  })

  it("tells the user a preserved non-map targets value does nothing", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { targets: "sentinel" } } })
    const issue = diagnoseSeats(seats).issues.find((entry) => entry.code === "malformed-targets")
    expect(issue?.severity).toBe("warning")
    expect(issue?.path).toBe(`seats.employees.${REAL_ID}.targets`)
    expect(issue?.message).toContain("preserved in the file")
    // A warning, not an error: junk beside good config must not block it.
    expect(diagnoseSeats(seats).ok).toBe(true)
  })

  it("says which fields still apply when a non-map targets sits beside the legacy pair", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "a/b", variant: "high", targets: 7 } } })
    const issue = diagnoseSeats(seats).issues.find((entry) => entry.code === "malformed-targets")
    expect(issue?.message).toContain(`"model" and "variant"`)
    // The legacy pair is what is in force, so it is still what counts.
    expect(diagnoseSeats(seats).effective).toBe(true)
    expect(codes(seats)).not.toContain("legacy-fields-shadowed")
  })

  it("tells the user a preserved non-option does nothing, by index", () => {
    const seats = parseSeats({
      control: true,
      employees: { [REAL_ID]: { targets: { t: { host: "codex", model: "gpt-5.6-sol", options: ["high", { id: "b", value: 5 }] } } } },
    })
    const found = diagnoseSeats(seats).issues.filter((entry) => entry.code === "malformed-option")
    expect(found.map((entry) => entry.path)).toEqual([
      `seats.employees.${REAL_ID}.targets.t.options.0`,
      `seats.employees.${REAL_ID}.targets.t.options.1.value`,
    ])
    expect(found[1]?.message).toContain(`Option "b"`)
    expect(found.every((entry) => entry.severity === "warning")).toBe(true)
    expect(diagnoseSeats(seats).ok).toBe(true)
  })

  it("never renders a literal undefined for a malformed lone option", () => {
    // `options-without-model` names the option in a sentence a TUI shows
    // verbatim. Now that bad entries survive, that branch can be handed one
    // with no id at all.
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { targets: { t: { host: "codex", options: [7] } } } } })
    const issue = diagnoseSeats(seats).issues.find((entry) => entry.code === "options-without-model")
    expect(issue?.message).not.toContain("undefined")
    expect(issue?.message).toContain(`Option "?"`)
  })

  it("still counts a preserved bad option towards the target having options", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { targets: { t: { host: "codex", options: [7] } } } } })
    expect(codes(seats)).not.toContain("empty-target")
  })
})

describe("the OpenCode slash rule, now that it lives outside shared diagnosis", () => {
  const SCOPE = { employeeId: REAL_ID, targetId: "opencode:default" }

  it("returns the same finding it used to raise, wording included", () => {
    const issue = diagnoseOpencodeModel("claude-opus-4-5", SCOPE)
    expect(issue?.code).toBe("malformed-model")
    expect(issue?.severity).toBe("error")
    expect(issue?.message).toContain("provider/model")
  })

  it("builds the config path itself, so no adapter reconstructs dotted syntax", () => {
    const issue = diagnoseOpencodeModel("claude-opus-4-5", SCOPE)!
    expect(issue.path).toBe(seatTargetPath(REAL_ID, "opencode:default", "model"))
    expect(issue.path).toBe(`seats.employees.${REAL_ID}.targets.opencode:default.model`)
  })

  it("names the target on every finding, because a finding a UI cannot place is useless", () => {
    const finding: SeatFinding = diagnoseOpencodeModel("opus", SCOPE)!
    expect(finding.employeeId).toBe(REAL_ID)
    expect(finding.targetId).toBe("opencode:default")
    expect(finding.host).toBe("opencode")
  })

  it("lets a caller override the path for a value that is not in the file yet", () => {
    const issue = diagnoseOpencodeModel("opus", { ...SCOPE, path: "picker.model" })
    expect(issue?.path).toBe("picker.model")
    expect(issue?.targetId).toBe("opencode:default")
  })

  it("passes a qualified model", () => {
    expect(diagnoseOpencodeModel("anthropic/claude-opus-4-5", SCOPE)).toBeUndefined()
  })

  it("passes a model id that carries more than one slash", () => {
    expect(diagnoseOpencodeModel("hpc-ai/deepseek/deepseek-v4-flash", SCOPE)).toBeUndefined()
  })

  it("says nothing about an absent model, which means inherit", () => {
    expect(diagnoseOpencodeModel("", SCOPE)).toBeUndefined()
  })

  it("exposes the predicate on its own, so a picker need not build a finding to throw away", () => {
    expect(isOpencodeModelId("anthropic/x")).toBe(true)
    expect(isOpencodeModelId("gpt-5.6-sol")).toBe(false)
  })
})

describe("seatTargetPath owns the dotted config syntax", () => {
  it("points at a target, and at one field of it", () => {
    expect(seatTargetPath("a", "codex:default")).toBe("seats.employees.a.targets.codex:default")
    expect(seatTargetPath("a", "codex:default", "host")).toBe("seats.employees.a.targets.codex:default.host")
  })

  it("produces exactly what diagnoseSeats stamps on its own target findings", () => {
    // The two must not drift: a TUI matches an adapter's finding against a
    // shared one by path, and two spellings would put them on different rows.
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { targets: { "grok:default": { host: "nope" } } } } })
    const issue = diagnoseSeats(seats).issues.find((entry) => entry.code === "unknown-host")
    expect(issue?.path).toBe(seatTargetPath(REAL_ID, "grok:default", "host"))
  })
})

describe("the OpenCode adapter returns findings the shared contract accepts", () => {
  const adapter = createOpencodeAdapter({ readModels: () => [] })

  it("reports a slashless model through diagnose, placed on its target", () => {
    const target: SeatTarget = { host: "opencode", model: "claude-opus-4-5" }
    const issues = adapter.diagnose("opencode:default", "opencode:default", target, REAL_ID)
    expect(issues).toHaveLength(1)
    const finding = issues[0]!
    expect(finding.code).toBe("malformed-model")
    expect(finding.severity).toBe("error")
    // Every field `SeatFinding` promises, from the real adapter call path —
    // not from the helper in isolation.
    expect(finding.employeeId).toBe(REAL_ID)
    expect(finding.targetId).toBe("opencode:default")
    expect(finding.host).toBe("opencode")
    expect(finding.path).toBe(seatTargetPath(REAL_ID, "opencode:default", "model"))
  })

  it("says nothing about a Codex target, because it is not its target to judge", () => {
    expect(adapter.diagnose("opencode:default", "codex:default", { host: "codex", model: "gpt-5.6-sol" }, REAL_ID)).toEqual([])
  })

  it("says nothing about a qualified OpenCode model", () => {
    expect(adapter.diagnose("opencode:default", "opencode:default", { host: "opencode", model: "anthropic/x" }, REAL_ID)).toEqual([])
  })

  it("does not duplicate what diagnoseSeats already says about the same target", () => {
    // The shared rules and the host rules must not both claim one mistake.
    // `unknown-host` is shared; the adapter is handed a target it does not own
    // and stays quiet.
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { targets: { t: { host: "openkode", model: "opus" } } } } })
    const target = seats.employees[REAL_ID]!.targets!["t"]!
    expect(codes(seats)).toEqual(["unknown-host"])
    expect(adapter.diagnose("opencode:default", "t", target, REAL_ID)).toEqual([])
  })
})

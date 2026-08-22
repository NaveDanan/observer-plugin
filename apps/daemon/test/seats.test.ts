import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ROSTER, behaviorDirective } from "@observer-ai/roster"
import {
  DEFAULT_SEATS,
  SEAT_VARIANTS,
  SeatsConfigSchema,
  applySeatSkills,
  diagnoseSeats,
  loadConfig,
  saveConfig,
  seatFor,
} from "@observer-ai/daemon"
import type { SeatIssueCode, SeatsConfig } from "@observer-ai/daemon"

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

  it("errors on a model written without its provider", () => {
    const seats = parseSeats({ control: true, employees: { [REAL_ID]: { model: "claude-opus-4-5" } } })
    const diagnosis = diagnoseSeats(seats)
    expect(diagnosis.ok).toBe(false)
    expect(codes(seats)).toContain("malformed-model")
    expect(diagnosis.issues[0]?.message).toContain("provider/model")
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
})

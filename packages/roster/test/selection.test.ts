import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { activeEmployees, employeeSetting, getEmployee, LEGACY_EMPLOYEE_IDS, rankEmployees, RETIRED_EMPLOYEE_IDS, ROSTER, rosterBriefing } from "../src/index.js"

describe("focused roster", () => {
  it("offers six distinct defaults and two opt-in specialists with Israeli names", () => {
    expect(activeEmployees().map((profile) => [profile.title, profile.fullName])).toEqual([
      ["Frontend Engineer", "Noam Cohen"], ["Backend Engineer", "David Levi"],
      ["Product Designer", "Yael Mizrahi"], ["Quality Engineer", "Daniel Peretz"],
      ["Platform Engineer", "Itai Friedman"], ["Research & Data Analyst", "Maya Shapiro"],
    ])
    expect(ROSTER.filter((profile) => profile.optional).map((profile) => profile.fullName)).toEqual(["Tamar Katz", "Eitan Dahan"])
  })

  it("requires explicit specialist enablement and excludes disabled roles from ranking", () => {
    const task = "Security threat modeling, security controls and vulnerability management"
    expect(rankEmployees(task, 20).map((match) => match.profile.id)).not.toContain("security-specialist")
    const enabled = activeEmployees({ employees: { "security-specialist": { enabled: true } } })
    expect(enabled).toHaveLength(7)
    expect(rankEmployees(task, 1, enabled)[0]?.profile.id).toBe("security-specialist")
    expect(activeEmployees({ employees: { "hardware-specialist": { enabled: false } } })).toHaveLength(6)
  })

  it("resolves renamed and merged IDs without changing input settings or reviving retired roles", () => {
    for (const [id, aliases] of Object.entries(LEGACY_EMPLOYEE_IDS)) {
      for (const alias of aliases) expect(getEmployee(alias)).toBe(getEmployee(id))
    }
    for (const id of RETIRED_EMPLOYEE_IDS) expect(getEmployee(id)).toBeUndefined()
    const settings = { "dr-maya-chen": { model: "analytics" }, "dr-mei-lin": { model: "science" } }
    const before = JSON.stringify(settings)
    expect(employeeSetting(settings, "research-analyst")).toEqual({ model: "science" })
    expect(employeeSetting({ ...settings, "research-analyst": {} }, "research-analyst")).toEqual({})
    expect(JSON.stringify(settings)).toBe(before)
    expect(employeeSetting({}, "toString")).toBeUndefined()
    expect(employeeSetting({}, "__proto__")).toBeUndefined()
  })

  it("keeps planning with the root and stages independent of employee count", () => {
    const briefing = rosterBriefing(activeEmployees())
    expect(briefing).toContain("root agent owns requirements")
    expect(briefing).toContain("Several instances of one specialty")
    for (const id of RETIRED_EMPLOYEE_IDS) expect(briefing).not.toContain(id)
    expect(briefing).not.toContain("observer-security-specialist")
    expect(briefing).toContain("Security and Hardware are optional")
  })

  it("keeps the printable catalog aligned without changing its public schema", () => {
    const catalog = JSON.parse(readFileSync(new URL("../../../tech_company_roster/company_roster.json", import.meta.url), "utf8"))
    expect(catalog.profile_count).toBe(8)
    expect(catalog.profiles.map((profile: { id: string; full_name: string }) => [profile.id, profile.full_name])).toEqual(ROSTER.map((profile) => [profile.id, profile.fullName]))
    for (const profile of catalog.profiles) {
      expect(profile.role.title).toBe(getEmployee(profile.id)?.title)
      expect(profile.image.relative_url).toMatch(/^images\/.+\.png$/)
    }
  })
})

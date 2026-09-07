import { describe, expect, it } from "vitest"
import { behaviorDirective, CAPABILITIES, employeeDescription, EMPLOYEES, isWorkMode, rosterBriefing, WORK_MODES } from "../src/index.js"
import { EMPLOYEE_CONTRACTS } from "../src/contracts.js"

describe("employee execution contracts", () => {
  it("covers the roster exactly with valid capabilities and handoffs", () => {
    const ids = new Set(EMPLOYEES.map((employee) => employee.id))
    expect(Object.keys(EMPLOYEE_CONTRACTS).sort()).toEqual([...ids].sort())
    const selections = new Set<string>()
    for (const employee of EMPLOYEES) {
      const work = employee.work!
      expect(work, employee.id).toBeDefined()
      expect(isWorkMode(work.defaultMode)).toBe(true)
      expect(work.mission.length).toBeGreaterThan(20)
      expect(work.workflow.length).toBeGreaterThanOrEqual(2)
      expect(work.deliverables.length).toBeGreaterThan(0)
      expect(work.verification.length).toBeGreaterThan(0)
      expect(work.boundaries.length).toBeGreaterThan(0)
      for (const handoff of work.handoffs) {
        expect(ids.has(handoff.employeeId), `${employee.id} -> ${handoff.employeeId}`).toBe(true)
        expect(handoff.employeeId).not.toBe(employee.id)
      }
      for (const capability of work.capabilities) expect(Object.hasOwn(CAPABILITIES, capability)).toBe(true)
      selections.add(work.selection)
    }
    expect(selections.size).toBe(ids.size)
  })

  it("separates the employee specialty from the assigned stage", () => {
    const arjun = EMPLOYEES.find((employee) => employee.id === "frontend-engineer")!
    const review = behaviorDirective(arjun, "Review the settings flow", "review")
    expect(review).toContain("Default mode: review")
    expect(review).toContain(WORK_MODES.review)
    expect(review).toContain(arjun.work!.mission)
    expect(review).toContain("Follow explicit task instructions over role defaults")
    expect(arjun.work!.defaultMode).toBe("implement")
  })

  it("exposes the selected specialty without unrelated profiles and stays within prompt budgets", () => {
    for (const employee of EMPLOYEES) {
      const prompt = behaviorDirective(employee)
      expect(prompt).toContain(employee.work!.mission)
      expect(prompt).toContain("one owner per browser session")
      expect(prompt).toContain("completed, partial, or blocked")
      expect(prompt).toContain("when the assignment explicitly authorizes it")
      expect(prompt.length).toBeLessThan(11500)
      expect(employeeDescription(employee).length).toBeLessThan(350)
      for (const other of EMPLOYEES.filter((entry) => entry.id !== employee.id)) {
        expect(prompt).not.toContain(other.work!.mission)
      }
    }
    const briefing = rosterBriefing(EMPLOYEES)
    expect(briefing.length).toBeLessThan(7500)
    expect(briefing).toContain("Respect a request to work alone")
    expect(briefing).toContain("disjoint ownership")
  })

  it("treats configured skills and browser preferences as discoverable capabilities", () => {
    const profile = { ...EMPLOYEES[0]!, skills: [{ name: "private-ui-skill", description: "Inspect the project design system" }] }
    const prompt = behaviorDirective(profile)
    expect(prompt).toContain("private-ui-skill: Inspect the project design system")
    expect(prompt).toContain("not installation claims")
    expect(prompt).toContain("it does not provide native desktop control")
    expect(prompt).toContain("observe the current page or screenshot")
    expect(prompt).not.toContain("Skills available to you")
  })

  it("supports older profiles and rejects prototype properties as modes", () => {
    const { work: _work, ...legacy } = EMPLOYEES[0]!
    expect(behaviorDirective(legacy)).toContain("Default mode: implement")
    expect(employeeDescription(legacy)).toContain(legacy.fields[0])
    expect(isWorkMode("toString")).toBe(false)
    expect(isWorkMode("__proto__")).toBe(false)
  })
})

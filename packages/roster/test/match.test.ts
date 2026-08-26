import { describe, expect, it } from "vitest"
import { EMPLOYEES } from "../src/data.js"
import { behaviorDirective, rosterBriefing } from "../src/guidance.js"
import { describeReason, getEmployee, matchEmployee, rankEmployees } from "../src/index.js"

describe("roster data", () => {
  it("has a unique id per employee", () => {
    const ids = EMPLOYEES.map((profile) => profile.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("reserves an empty skills list per employee", () => {
    for (const profile of EMPLOYEES) expect(profile.skills).toEqual([])
  })
})

describe("matchEmployee", () => {
  it("seats infrastructure work with the SRE", () => {
    const match = matchEmployee(
      "Our deployments work differently in every environment and nobody can explain why the production service is unhealthy. Set up kubernetes and CI/CD.",
    )
    expect(match?.profile.id).toBe("elias-mercer")
  })

  it("seats UI work with the frontend engineer", () => {
    const match = matchEmployee(
      "The React components are inconsistent and the interface feels slow. Refactor the component architecture and improve accessibility.",
    )
    expect(match?.profile.id).toBe("arjun-mehta")
  })

  it("seats flaky test investigations with QA", () => {
    const match = matchEmployee("A bug cannot be reproduced consistently and the automated test suite has become slow or flaky.")
    expect(match?.profile.id).toBe("daniel-brooks")
  })

  it("seats threat modelling with security", () => {
    const match = matchEmployee("A new service will handle sensitive information; we need a threat model before implementation.")
    expect(["nia-okafor", "adrian-cole"]).toContain(match?.profile.id)
  })

  it("returns undefined for text that matches nobody", () => {
    expect(matchEmployee("")).toBeUndefined()
    expect(matchEmployee("the the the")).toBeUndefined()
  })

  it("is deterministic for identical input", () => {
    const task = "Design an experiment to check whether the metric improvement is meaningful."
    const first = matchEmployee(task)
    const second = matchEmployee(task)
    expect(first?.profile.id).toBe(second?.profile.id)
  })
})

describe("rankEmployees", () => {
  it("orders candidates best first and honours the limit", () => {
    const ranked = rankEmployees("Scale the database and redesign the API contracts.", 3)
    expect(ranked.length).toBe(3)
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(ranked[1]!.score)
    expect(ranked[1]!.score).toBeGreaterThanOrEqual(ranked[2]!.score)
  })

  it("explains at least one reason for a strong match", () => {
    const [best] = rankEmployees("Kubernetes rollout and observability for the new cluster.", 1)
    expect(best).toBeDefined()
    if (!best) return
    expect(best.reasons.length).toBeGreaterThan(0)
    expect(describeReason(best.reasons[0]!)).toMatch(/skill|Called when/i)
  })
})

describe("getEmployee", () => {
  it("finds profiles by id", () => {
    expect(getEmployee("malik-johnson")?.title).toBe("Staff Backend Engineer")
    expect(getEmployee("nobody")).toBeUndefined()
  })
})

describe("guidance", () => {
  it("renders a persona directive", () => {
    const profile = EMPLOYEES[0]!
    const directive = behaviorDirective(profile, "Rebuild the settings screen.")
    expect(directive).toContain("You are Arjun Mehta")
    expect(directive).toContain(profile.tone)
    expect(directive).toContain("Rebuild the settings screen.")
  })

  it("omits the task line when no task is given", () => {
    const directive = behaviorDirective(EMPLOYEES[0]!)
    expect(directive).not.toContain("Apply that expertise")
  })

  it("renders a briefing naming every employee", () => {
    const briefing = rosterBriefing(EMPLOYEES)
    for (const profile of EMPLOYEES) expect(briefing).toContain(profile.fullName)
  })

  it("offers the employees as subagent staffing with a subcontractor fallback", () => {
    const briefing = rosterBriefing(EMPLOYEES)
    expect(briefing).toContain("delegate work to subagents")
    expect(briefing).toContain("subcontractor")
  })

  it("prefers employee agents and requires a reason when none is selected", () => {
    const briefing = rosterBriefing(EMPLOYEES)
    expect(briefing).toContain("Prefer an employee agent")
    expect(briefing).toContain('fork_turns: "none"')
    expect(briefing).toContain("state the reason")
    for (const profile of EMPLOYEES) {
      for (const field of profile.fields) expect(briefing).toContain(field)
    }
  })
})

/**
 * The guard the ticket asks for: **all fourteen roster employees appear, and a
 * fifteenth hire cannot silently vanish.**
 *
 * Two assertions, deliberately, because they fail for different reasons:
 *
 *  1. `employeeRows` returns one row per roster profile, in roster order,
 *     whatever the config holds. That catches a regression in the row model.
 *  2. The component actually *renders* those ids. `EmployeeRoster` is pure
 *     props, so `renderToStaticMarkup` gives real DOM output with no jsdom, no
 *     daemon and no fixtures — and the `data-employee-id` attributes are read
 *     back out of the markup in document order. That catches a regression
 *     nobody would find by reading the row model: a `.slice`, a `.filter`, a
 *     conditional that skips a card.
 *
 * The roster is imported, never restated. A test with its own list of fourteen
 * names is a test that agrees with itself and nothing else.
 */

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ROSTER } from "@observer-ai/roster"
import type { HostSummary, SeatIssue, SeatsConfig } from "../src/api"
import type { HostDirectory } from "../src/settings/employees/hosts"
import { EmployeeRoster } from "../src/settings/employees/EmployeeRoster"
import { employeeRows, matchesQuery, targetSummary } from "../src/settings/employees/roster"

const EMPTY_SEATS: SeatsConfig = { control: false, employees: {} }

/**
 * A host directory as `GET /v1/hosts` would deliver one.
 *
 * Built here rather than fetched: these tests are about the roster being
 * complete and the card being honest, and both must hold whatever the host
 * endpoint said. `apps/web/test/employeeHosts.test.ts` owns the wire contract.
 */
const HOSTS: HostSummary[] = [
  {
    id: "opencode",
    label: "OpenCode",
    profiles: [{ id: "opencode:default", host: "opencode", label: "OpenCode" }],
    capabilities: { discovery: "cached", childModel: "supported", childReasoning: "supported", requiresReload: true },
    warnings: [],
  },
  {
    id: "codex",
    label: "Codex",
    profiles: [{ id: "codex:default", host: "codex", label: "Codex" }],
    capabilities: {
      discovery: "live",
      childModel: "experimental",
      childReasoning: "experimental",
      requiresReload: false,
    },
    warnings: [],
  },
  {
    id: "claude",
    label: "Claude Code",
    profiles: [{ id: "claude:default", host: "claude", label: "Claude Code" }],
    capabilities: {
      discovery: "cached",
      childModel: "unsupported",
      childReasoning: "unsupported",
      requiresReload: true,
    },
    warnings: [],
  },
]

const DIRECTORY: HostDirectory = { hosts: HOSTS, loading: false, error: undefined, settled: true }

/** The ids in the order the markup puts them, straight out of the attributes. */
function renderedIds(seats: SeatsConfig, issues: SeatIssue[] = []): string[] {
  const markup = renderToStaticMarkup(
    createElement(EmployeeRoster, {
      rows: employeeRows(ROSTER, seats, issues),
      directory: DIRECTORY,
      seatControl: seats.control,
      onOpen: () => undefined,
    }),
  )
  return [...markup.matchAll(/data-employee-id="([^"]+)"/g)].map((match) => match[1] as string)
}

describe("every employee appears", () => {
  it("returns one row per roster profile, in roster order, on an empty config", () => {
    expect(employeeRows(ROSTER, EMPTY_SEATS, []).map((row) => row.id)).toEqual(ROSTER.map((profile) => profile.id))
  })

  it("renders exactly the roster ids, in order", () => {
    expect(renderedIds(EMPTY_SEATS)).toEqual(ROSTER.map((profile) => profile.id))
  })

  it("renders all fourteen when only two of them are configured", () => {
    const seats: SeatsConfig = {
      control: true,
      employees: {
        "arjun-mehta": { targets: { "opencode:default": { host: "opencode", model: "anthropic/claude-opus-4-5" } } },
        "malik-johnson": { skills: [{ name: "contracts", description: "" }] },
      },
    }
    expect(renderedIds(seats)).toEqual(ROSTER.map((profile) => profile.id))
    expect(ROSTER).toHaveLength(14)
  })

  it("renders all fourteen when the config names somebody who is not on the roster", () => {
    const seats: SeatsConfig = {
      control: false,
      employees: { "arjun-mehtaa": { model: "anthropic/claude-opus-4-5" } },
    }
    const issues: SeatIssue[] = [
      {
        code: "unknown-employee",
        severity: "error",
        path: "seats.employees.arjun-mehtaa",
        employeeId: "arjun-mehtaa",
        message: '"arjun-mehtaa" is not an employee on the roster.',
      },
    ]
    // The typo gets no row of its own — the panel surfaces it from the
    // daemon's finding instead — and it costs nobody else theirs.
    expect(renderedIds(seats, issues)).toEqual(ROSTER.map((profile) => profile.id))
  })

  it("survives a seats config with junk where a spec should be", () => {
    const seats = { control: false, employees: { "arjun-mehta": 7 } } as unknown as SeatsConfig
    expect(renderedIds(seats)).toEqual(ROSTER.map((profile) => profile.id))
  })

  it("joins the config on rather than iterating it", () => {
    const seats: SeatsConfig = {
      control: false,
      employees: { "dr-mei-lin": { targets: { "codex:default": { host: "codex", model: "gpt-5.6-sol" } } } },
    }
    const rows = employeeRows(ROSTER, seats, [])
    const mei = rows.find((row) => row.id === "dr-mei-lin")
    expect(mei?.targets.map((target) => target.id)).toEqual(["codex:default"])
    expect(rows.filter((row) => row.targets.length > 0)).toHaveLength(1)
    expect(rows.every((row) => row.seated === (row.id === "dr-mei-lin"))).toBe(true)
  })
})

/**
 * The claim the whole effort turns on, checked in the markup rather than in a
 * helper: a card for a Cursor target must say, on the card, that nothing is
 * applied to a delegated child. A regression here is invisible in the status
 * module's own tests, because the card could simply stop rendering the badge.
 */
describe("the card never overstates what a host will do", () => {
  function markupFor(host: string, control: boolean): string {
    const seats: SeatsConfig = {
      control,
      employees: {
        "arjun-mehta": { targets: { [`${host}:default`]: { host, model: "some-model" } } },
      },
    }
    return renderToStaticMarkup(
      createElement(EmployeeRoster, {
        rows: employeeRows(ROSTER, seats, []),
        directory: DIRECTORY,
        seatControl: control,
        onOpen: () => undefined,
      }),
    )
  }

  it("never says applied for a host the daemon does not list", () => {
    // Cursor and Grok are absent from `GET /v1/hosts` because no adapter claims
    // them, so the card says "no adapter" rather than borrowing the wording of
    // a capability check that was never performed.
    for (const host of ["cursor", "grok"]) {
      const markup = markupFor(host, true)
      expect(markup, host).toContain("no adapter")
      expect(markup, host).not.toContain(">applied<")
      expect(markup, host).not.toContain("experimental")
    }
  })

  it("says Claude is not applied to children, because its adapter looked and said so", () => {
    const markup = markupFor("claude", true)
    expect(markup).toContain("not applied to children")
    expect(markup).not.toContain(">applied<")
  })

  it("calls a Codex target experimental rather than applied", () => {
    expect(markupFor("codex", true)).toContain("experimental")
    expect(markupFor("codex", true)).not.toContain(">applied<")
  })

  it("only ever says applied for OpenCode with seat control on", () => {
    expect(markupFor("opencode", true)).toContain(">applied<")
    expect(markupFor("opencode", false)).toContain("configured, not applied")
    expect(markupFor("opencode", false)).not.toContain(">applied<")
  })

  it("says nothing at all while the host list is still in flight", () => {
    const seats: SeatsConfig = {
      control: true,
      employees: { "arjun-mehta": { targets: { "opencode:default": { host: "opencode" } } } },
    }
    const markup = renderToStaticMarkup(
      createElement(EmployeeRoster, {
        rows: employeeRows(ROSTER, seats, []),
        directory: { hosts: [], loading: true, error: undefined, settled: false },
        seatControl: true,
        onOpen: () => undefined,
      }),
    )
    expect(markup).toContain("checking…")
    expect(markup).not.toContain(">applied<")
  })
})

describe("search", () => {
  it("matches on name, title and strengths, and is the only thing that hides a row", () => {
    const arjun = ROSTER.find((profile) => profile.id === "arjun-mehta")
    if (!arjun) throw new Error("no arjun-mehta on the roster")
    expect(matchesQuery(arjun, "")).toBe(true)
    expect(matchesQuery(arjun, "arjun")).toBe(true)
    expect(matchesQuery(arjun, "frontend")).toBe(true)
    expect(matchesQuery(arjun, arjun.fields[0] ?? "react")).toBe(true)
    expect(matchesQuery(arjun, "kubernetes")).toBe(false)
  })

  it("requires every term, so a two-word search narrows rather than widens", () => {
    const matched = ROSTER.filter((profile) => matchesQuery(profile, "senior engineer"))
    expect(matched.length).toBeGreaterThan(0)
    expect(matched.length).toBeLessThan(ROSTER.length)
  })
})

describe("target summary", () => {
  it("names the option by the host's own id, because that is what is in the file", () => {
    expect(
      targetSummary(DIRECTORY, {
        id: "opencode:default",
        derived: false,
        target: {
          host: "opencode",
          model: "anthropic/claude-opus-4-5",
          options: [{ id: "variant", value: "high" }],
        },
      }),
    ).toBe("OpenCode · anthropic/claude-opus-4-5 · variant high")
  })

  it("renders a boolean option as on or off rather than as true", () => {
    expect(
      targetSummary(DIRECTORY, {
        id: "claude:default",
        derived: false,
        target: { host: "claude", model: "haiku", options: [{ id: "thinking", value: true }] },
      }),
    ).toBe("Claude Code · haiku · thinking on")
  })

  it("says a target with no model inherits, rather than showing an empty gap", () => {
    expect(targetSummary(DIRECTORY, { id: "grok:default", derived: false, target: { host: "grok" } })).toBe(
      // Grok is absent from `/v1/hosts`, so the raw id is the honest label.
      "grok · inherits the session's model",
    )
  })
})

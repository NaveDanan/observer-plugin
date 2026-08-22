/**
 * The row model behind the Employees list.
 *
 * One function, and the reason it exists rather than being a `.map` inside the
 * component: **every roster employee must appear, always**. A list assembled
 * from `Object.keys(seats.employees)` would show the four people somebody has
 * already configured and quietly hide the other ten, and a fifteenth hire would
 * never appear at all. So the roster is the spine, the config is joined onto
 * it, and `apps/web/test/employeeRoster.test.ts` asserts the ids this returns —
 * and the ids the component actually renders — equal `ROSTER.map(p => p.id)` in
 * order.
 *
 * Pure, so that test needs no DOM, no daemon and no fixtures beyond the real
 * roster.
 */

import type { RosterProfile } from "@observer-ai/roster"
import type { SeatIssue, SeatSpec, SeatsConfig } from "../../api"
import { hostLabel } from "./directory"
import type { HostDirectory } from "./hosts"
import { issuesFor, isSeated, seatSkills } from "./seat"
import { targetHost, targetModel, targetOptions, targetRows, type TargetRow } from "./targets"

export interface EmployeeRow {
  /** The roster id, which is also the key a seat is filed under. */
  id: string
  profile: RosterProfile
  /** The seat as the daemon last returned it, or undefined for no seat. */
  spec: SeatSpec | undefined
  targets: TargetRow[]
  skillCount: number
  seated: boolean
  /** The daemon's findings for this employee, verbatim and unfiltered. */
  issues: SeatIssue[]
}

/**
 * One row per roster profile, in roster order, whatever the config says.
 *
 * `seats` is joined on, never iterated. A seat whose id matches nobody is not
 * dropped here — it simply has no row, and the panel surfaces it separately
 * from the daemon's `unknown-employee` findings so the user can re-key their
 * typo rather than watch it disappear.
 */
export function employeeRows(
  profiles: ReadonlyArray<RosterProfile>,
  seats: SeatsConfig,
  issues: ReadonlyArray<SeatIssue>,
): EmployeeRow[] {
  const employees = seats?.employees ?? {}
  return profiles.map((profile) => {
    const spec = employees[profile.id]
    return {
      id: profile.id,
      profile,
      spec,
      targets: targetRows(spec),
      skillCount: seatSkills(spec).length,
      seated: isSeated(spec),
      issues: issuesFor(issues, profile.id),
    }
  })
}

/** Name, title and strengths: the three things a card shows and a search reads. */
export function matchesQuery(profile: RosterProfile, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = `${profile.fullName} ${profile.title} ${profile.fields.join(" ")}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/**
 * One target in a sentence fragment, for the card that has no room for a table.
 *
 * `OpenCode · anthropic/claude-opus-4-5 · variant high`. The option is named by
 * the host's own id rather than being relabelled "effort", because that id is
 * what is in the config file the user may go and edit, and a summary that
 * renames it sends them looking for a key that is not there.
 *
 * The host's display name comes from `/v1/hosts` and falls back to the raw id,
 * so a target naming a host the daemon does not list still reads correctly
 * rather than printing a blank.
 */
export function targetSummary(directory: HostDirectory, row: TargetRow): string {
  const host = hostLabel(directory, targetHost(row.target) || "unknown host")
  const model = targetModel(row.target) ?? "inherits the session's model"
  const options = targetOptions(row.target).map((option) =>
    typeof option.value === "boolean" ? `${option.id} ${option.value ? "on" : "off"}` : `${option.id} ${option.value}`,
  )
  return [host, model, ...options].join(" · ")
}

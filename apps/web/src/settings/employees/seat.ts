/**
 * The employee half of a seat: skills, emptiness, and the daemon's findings
 * about it.
 *
 * Nothing here decides whether a seat is wrong. `diagnoseSeats` owns that and
 * ships it on `config.diagnosis`, and the rule is worth restating because this
 * surface is the one most tempted to break it: every red badge on the Employees
 * page is the daemon's own sentence, rendered verbatim. The single exception is
 * `malformedModelMessage`, documented below, which has a reason it cannot wait
 * for a round trip.
 */

import type { SeatIssue, SeatIssueSeverity, SeatSkill, SeatSpec } from "../../api"
import { readTargets } from "./targets"

export function seatSkills(spec: SeatSpec | undefined): SeatSkill[] {
  return Array.isArray(spec?.skills) ? spec.skills : []
}

/**
 * A seat with its skills replaced, every other field untouched.
 *
 * An empty list deletes the key rather than storing `[]`, because the daemon's
 * schema drops an empty `skills` anyway and leaving one behind would make the
 * config the user reads back differ from the one they saved.
 */
export function setSkills(spec: SeatSpec | undefined, skills: SeatSkill[]): SeatSpec {
  const next: SeatSpec = { ...(spec ?? {}) }
  if (skills.length === 0) delete next.skills
  else next.skills = skills
  return next
}

/** Whether this employee has a seat a user would recognise as configured. */
export function isSeated(spec: SeatSpec | undefined): boolean {
  if (spec === undefined) return false
  return Object.keys(readTargets(spec)).length > 0 || seatSkills(spec).length > 0
}

const KNOWN_SEAT_FIELDS = new Set(["model", "variant", "skills", "targets"])

/**
 * Whether a seat can be dropped from the config outright.
 *
 * A spec carrying fields Observer does not apply (`temperature`, `permission`)
 * is *not* empty: the daemon preserves those keys on purpose, and deleting the
 * employee's entry to tidy up an empty target would take them with it.
 */
export function isEmptySeat(spec: SeatSpec | undefined): boolean {
  if (spec === undefined) return true
  if (isSeated(spec)) return false
  return Object.keys(spec).every((key) => KNOWN_SEAT_FIELDS.has(key))
}

export function issuesFor(issues: ReadonlyArray<SeatIssue>, employeeId: string): SeatIssue[] {
  return issues.filter((issue) => issue.employeeId === employeeId)
}

/**
 * The findings the daemon scoped to one target.
 *
 * Matched on `issue.targetId` and never by parsing `issue.path`. Target keys
 * contain `:` and may contain `.`, so splitting the dotted path back apart is
 * not safe — which is exactly why the daemon sends `targetId` as its own field.
 */
export function issuesForTarget(issues: ReadonlyArray<SeatIssue>, targetId: string): SeatIssue[] {
  return issues.filter((issue) => issue.targetId === targetId)
}

/** Findings about the employee as a whole rather than about one of its targets. */
export function issuesWithoutTarget(issues: ReadonlyArray<SeatIssue>): SeatIssue[] {
  return issues.filter((issue) => issue.targetId === undefined)
}

export function badgeVariant(severity: SeatIssueSeverity): "error" | "warning" | "secondary" {
  if (severity === "error") return "error"
  if (severity === "warning") return "warning"
  return "secondary"
}

/**
 * The `malformed-model` sentence, for an OpenCode model id the user is still
 * typing.
 *
 * The only rule this folder applies to a config, and it is here because there
 * is nothing to wait for: the daemon raises `malformed-model` when a seat is
 * saved, but the field should say so while it is being typed rather than after
 * a round trip. The check and the sentence are copied verbatim from
 * `diagnoseOpencodeModel`, and a real finding from the daemon still wins
 * wherever one arrives.
 *
 * It takes a host and answers `undefined` for four of the five, because the
 * slash rule is OpenCode's addressing scheme and not a fact about models.
 * Applying it everywhere would reject Codex's `gpt-5.6-sol` and Grok's
 * `grok-build`, both of which are exactly right as written.
 */
export function malformedModelMessage(host: string, model: string): string | undefined {
  if (host !== "opencode") return undefined
  if (model.length === 0 || model.includes("/")) return undefined
  return `"${model}" is missing its provider. Models are written "provider/model", for example "anthropic/claude-opus-4-5".`
}

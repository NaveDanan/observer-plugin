import { ROSTER } from "@observer-ai/roster"
import type { EmployeeProfile, EmployeeSkill } from "@observer-ai/roster"
import { z } from "zod"

/**
 * Seat specs: the model, reasoning effort and skills a user assigned to an
 * employee.
 *
 * A seat spec is *desired* configuration. It is not the `model` recorded on an
 * agent, which is observed — what the host told us it actually ran. The two
 * must never be conflated; see CONTEXT.md.
 *
 * What a host can actually honour is narrow, and the schema is shaped around
 * it rather than around what we wish were true:
 *
 *  - OpenCode's task tool takes no `model` parameter. The only lever is
 *    `subagent_type` -> agent definition -> `model`. Applying a seat spec
 *    therefore means generating a hidden per-employee agent file and
 *    rewriting `args.subagent_type` at `tool.execute.before`. That is
 *    opt-in (`seats.control`) and off by default, because rewriting
 *    `subagent_type` to an agent that does not exist on disk makes the host
 *    fail the delegation outright with "Unknown agent type".
 *  - `variant` (the reasoning effort) is documented in the host as applying
 *    "only when using the agent's configured model", and the task tool
 *    confirms it with `variant: agent.model ? undefined : effort`. An effort
 *    with no model is a no-op, so `diagnoseSeats` says so out loud.
 *  - Only OpenCode can honour any of this today. The other hosts integrate
 *    through a subprocess and are not seated at all.
 *
 * Skills are the exception: they are prompt text, they ride the directive
 * `behaviorDirective` already renders, and they carry none of the above
 * failure risk. They apply whether or not `control` is on.
 */

/**
 * The effort levels a TUI should offer, weakest first.
 *
 * This is the union across the host's model catalogue, not a guarantee: each
 * model declares its own subset (many offer only low/medium/high) and the host
 * rejects a variant its model does not list. The schema therefore accepts any
 * non-empty string and `diagnoseSeats` warns on an unrecognised one, so a new
 * effort level shipping in models.dev cannot be rejected by a stale enum here.
 */
export const SEAT_VARIANTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export type SeatVariant = (typeof SEAT_VARIANTS)[number]

/**
 * Additionally tolerated without a warning: a handful of models expose
 * `["none","default"]` rather than a graded scale.
 */
const ALSO_RECOGNISED_VARIANTS = new Set<string>(["default"])

/**
 * One employee's assignment. Every field is optional: an omitted `model` means
 * "inherit whatever model the session is already running".
 *
 * The index signature is deliberate. Users hand-edit this file and OpenCode
 * agents accept more than Observer applies (`temperature`, `top_p`, `steps`,
 * `permission`). Keys we do not understand survive a save instead of being
 * deleted, and `diagnoseSeats` reports them rather than pretending they work.
 */
export interface SeatSpec {
  /** `providerID/modelID`, e.g. `anthropic/claude-opus-4-5`. */
  model?: string
  /** Reasoning effort. Inert unless `model` is also set — see `diagnoseSeats`. */
  variant?: string
  /** Extra skills folded into the employee's profile at match time. */
  skills?: EmployeeSkill[]
  [extra: string]: unknown
}

export interface SeatsConfig {
  /**
   * Whether Observer may take real control of the model an employee runs, by
   * generating hidden per-employee agent definitions and rewriting the host's
   * `subagent_type`. Off by default: it changes what the user is billed for
   * and can fail a delegation outright if the generated agent is missing.
   *
   * `skills` are unaffected by this flag.
   */
  control: boolean
  /** Keyed by the stable roster id, e.g. `arjun-mehta`, `dr-mei-lin`. */
  employees: Record<string, SeatSpec>
}

export const DEFAULT_SEATS: SeatsConfig = { control: false, employees: {} }

/**
 * A skill, written either as a bare name or as a full object.
 *
 * `"react"` and `{ "name": "react", "description": "" }` are the same thing.
 * The bare form is what people actually type; it is canonicalised on the way
 * in so every consumer sees one shape (`EmployeeSkill`) and never a union.
 */
const SeatSkillSchema: z.ZodType<EmployeeSkill, z.ZodTypeDef, unknown> = z.union([
  z
    .string()
    .min(1)
    .transform((name) => ({ name, description: "" })),
  z.object({ name: z.string().min(1), description: z.string().catch("") }),
])

/**
 * Field-level fallback throughout: one malformed value must cost the user that
 * value, never the surrounding object. `{ model: 5, variant: "high" }` keeps
 * the variant.
 */
export const SeatSpecSchema = z
  .object({
    model: z.string().min(1).optional().catch(undefined),
    variant: z.string().min(1).optional().catch(undefined),
    skills: z.array(SeatSkillSchema).optional().catch(undefined),
  })
  .passthrough()
  .catch({})

export const SeatsConfigSchema = z
  .object({
    control: z.boolean().catch(false),
    // Any string key parses. Whether it names a real employee is a finding,
    // not a parse error: an unrecognised id must survive the save so the user
    // can see and fix their typo instead of watching it disappear.
    employees: z.record(z.string(), SeatSpecSchema).catch({}),
  })
  .catch({ control: false, employees: {} })

/** Compile-time proof the schema still produces the published type. */
type SchemaMatchesType = z.infer<typeof SeatsConfigSchema> extends { control: boolean } ? true : never
const _schemaMatchesType: SchemaMatchesType = true
void _schemaMatchesType

export type SeatIssueCode =
  | "unknown-employee"
  | "variant-without-model"
  | "unrecognised-variant"
  | "malformed-model"
  | "unknown-field"
  | "empty-seat"
  | "control-disabled"

/**
 * `error` means the seat cannot work as written. `warning` means it parses but
 * will not do what the user expects. `info` is context the UI should show so
 * it does not overstate what is in effect.
 */
export type SeatIssueSeverity = "error" | "warning" | "info"

export interface SeatIssue {
  code: SeatIssueCode
  severity: SeatIssueSeverity
  /** Dotted config path, e.g. `seats.employees.arjun-mehta.variant`. */
  path: string
  /** The roster id the finding is scoped to, when it is scoped to one. */
  employeeId?: string
  /** One sentence, safe to render verbatim in a TUI or an installer log. */
  message: string
}

export interface SeatDiagnosis {
  /** No `error` findings: every seat named a real employee. */
  ok: boolean
  /**
   * Whether this config changes anything at all right now — `control` is on
   * and at least one seat sets a usable model, or some seat adds skills.
   * The UI should not claim an employee "runs Opus" when this is false.
   */
  effective: boolean
  issues: SeatIssue[]
}

const ROSTER_IDS = new Set(ROSTER.map((profile) => profile.id))

/** Fields Observer reads from a seat spec. Anything else is reported, not applied. */
const KNOWN_SEAT_FIELDS = new Set(["model", "variant", "skills"])

/**
 * Reports everything wrong or inert about a seats config, and throws nothing.
 *
 * Pure, so the TUI, the installer and the daemon all reach the same verdict
 * without one of them having to guess. Callers render `issues`; they should
 * not re-derive their own rules.
 */
export function diagnoseSeats(seats: SeatsConfig): SeatDiagnosis {
  const issues: SeatIssue[] = []
  let controllable = 0
  let skilled = 0

  // Defensive: this is the one function a TUI calls on half-typed input, and
  // its whole contract is that it reports instead of throwing.
  const employees = seats?.employees ?? {}

  for (const [id, entry] of Object.entries(employees)) {
    const spec: SeatSpec = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}
    const path = `seats.employees.${id}`
    const add = (code: SeatIssueCode, severity: SeatIssueSeverity, suffix: string, message: string): void => {
      issues.push({ code, severity, path: suffix ? `${path}.${suffix}` : path, employeeId: id, message })
    }

    if (!ROSTER_IDS.has(id)) {
      add(
        "unknown-employee",
        "error",
        "",
        `"${id}" is not an employee on the roster, so this seat is never used. It is kept in the file so you can correct the id.`,
      )
    }

    const hasModel = typeof spec.model === "string" && spec.model.length > 0
    const hasVariant = typeof spec.variant === "string" && spec.variant.length > 0
    const skillCount = Array.isArray(spec.skills) ? spec.skills.length : 0

    if (hasModel && !spec.model!.includes("/")) {
      add(
        "malformed-model",
        "error",
        "model",
        `"${spec.model}" is missing its provider. Models are written "provider/model", for example "anthropic/claude-opus-4-5".`,
      )
    }

    if (hasVariant && !hasModel) {
      add(
        "variant-without-model",
        "warning",
        "variant",
        `Reasoning effort "${spec.variant}" has no effect without a model: OpenCode applies a variant only to an agent's own configured model. Set a model, or drop the variant.`,
      )
    }

    if (hasVariant && !isRecognisedVariant(spec.variant!)) {
      add(
        "unrecognised-variant",
        "warning",
        "variant",
        `"${spec.variant}" is not a reasoning effort Observer recognises (${SEAT_VARIANTS.join(", ")}). Models accept different subsets, so this may still work — the host has the final say.`,
      )
    }

    for (const field of Object.keys(spec)) {
      if (KNOWN_SEAT_FIELDS.has(field)) continue
      add("unknown-field", "info", field, `Observer does not apply "${field}" yet. It is preserved in the file untouched.`)
    }

    if (!hasModel && !hasVariant && skillCount === 0) {
      add("empty-seat", "info", "", "This seat sets nothing, so it changes nothing.")
    }

    if (hasModel) controllable += 1
    if (skillCount > 0) skilled += 1
  }

  if (!seats.control && controllable > 0) {
    issues.push({
      code: "control-disabled",
      severity: "info",
      path: "seats.control",
      message: `Model and reasoning effort are set for ${controllable} employee${controllable === 1 ? "" : "s"} but "control" is off, so the host keeps choosing the model. Skills still apply.`,
    })
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    effective: (seats.control && controllable > 0) || skilled > 0,
    issues,
  }
}

function isRecognisedVariant(variant: string): boolean {
  return (SEAT_VARIANTS as readonly string[]).includes(variant) || ALSO_RECOGNISED_VARIANTS.has(variant)
}

/**
 * The seat spec Observer would apply for an employee, or undefined when there
 * is nothing to apply.
 *
 * An unknown id yields undefined rather than an empty object, so callers
 * cannot accidentally act on a typo.
 */
export function seatFor(seats: SeatsConfig, employeeId: string): SeatSpec | undefined {
  if (!ROSTER_IDS.has(employeeId)) return undefined
  return seats?.employees?.[employeeId]
}

/**
 * Folds a seat's configured skills into an employee profile.
 *
 * This is the seam where configured skills become behaviour. It sits at match
 * time — the daemon's `/v1/roster/match`, immediately before
 * `behaviorDirective` renders the profile — for two reasons: the roster
 * package stays a pure data package with no config dependency, and the
 * OpenCode plugin needs no change, because it already appends whatever
 * directive the daemon hands back.
 *
 * Skills are not gated on `control`: they are prompt text, not a model
 * substitution, so they cannot fail a delegation.
 *
 * Returns the profile unchanged when there is nothing to add, so callers can
 * pass every profile through without checking first.
 */
export function applySeatSkills<T extends EmployeeProfile>(profile: T, seats: SeatsConfig): T {
  const extra = seatFor(seats, profile.id)?.skills
  if (!extra || extra.length === 0) return profile
  const seen = new Set(profile.skills.map((skill) => skill.name.toLowerCase()))
  const merged = [...profile.skills]
  for (const skill of extra) {
    const key = skill.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(skill)
  }
  return { ...profile, skills: merged }
}

import { ROSTER } from "@observer-ai/roster"
import type { EmployeeProfile, EmployeeSkill } from "@observer-ai/roster"
import { z } from "zod"
import { HOST_KINDS, isHostKind } from "./providers.js"

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
 *
 * ## Targets
 *
 * A seat now carries zero or more `targets`, one per host profile, because a
 * single `model` plus a single `variant` cannot describe five hosts. Claude
 * needs effort *and* context window *and* thinking; Cursor has four
 * independent ACP options; Codex has a reasoning effort of its own. One string
 * field cannot hold that, and widening `variant` into a union would make every
 * read site guess which host's vocabulary it was looking at.
 *
 * Two rules keep this file host-agnostic:
 *
 *  - A target's `model` is **opaque** above the adapter. Nothing here parses
 *    it, and nothing here decides whether it is well formed. The old
 *    `includes("/")` check was OpenCode policy — `providerID/modelID` is
 *    OpenCode's addressing scheme, not a fact about models — and applying it
 *    to every host would reject Codex's `gpt-5.6-sol` and Grok's `grok-build`
 *    as errors when both are exactly right. It now lives in
 *    `diagnoseOpencodeModel`, which the OpenCode adapter owns and calls.
 *  - A target's `options` are `{ id, value }` pairs, opaque in the same way.
 *    `diagnoseSeats` reports only what is true of every host: an option set
 *    with no model to apply it to does nothing, whichever host it names.
 *
 * The legacy top-level `model`/`variant` pair is read as an implicit
 * `opencode:default` target by `seatTargets`. It is *derived*, never
 * materialised on load: writing `targets` into a seat at parse time would make
 * `saveConfig(loadConfig())` rewrite a config the user never asked to change,
 * and would leave the same setting recorded twice with nothing to say which
 * copy wins next time. `migrateSeatSpecToTargets` is the one place the legacy
 * fields are dropped, and it only runs on a save that is already writing
 * `targets`.
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
 * The target id the legacy top-level `model`/`variant` pair is read as.
 *
 * `host:profile`, matching `config.providers`' instance keys, so a seat can
 * name a second Codex profile later without the ids colliding. The `default`
 * profile is the one every install has.
 */
export const LEGACY_TARGET_ID = "opencode:default"

/**
 * One knob on a host, named by the host's own id for it.
 *
 * `string | boolean` and no third case on purpose. Every option the five hosts
 * expose today is either a named level (`"high"`, `"adaptive"`) or a switch
 * (fast mode, thinking). A numeric budget would need a unit, a range and a
 * per-model ceiling to be meaningful, and none of those are knowable here; the
 * adapter that owns the host is where that belongs. An option with a value
 * outside this union is dropped and the rest of the list survives.
 *
 * A flat array rather than a record because order is the order a TUI renders
 * the controls in, and a record would lose it.
 */
export interface SeatTargetOption {
  /** The host's own name for the knob, e.g. `variant`, `reasoningEffort`. */
  id: string
  value: string | boolean
  /**
   * Same bargain as `SeatSpec`'s index signature: an option key from a newer
   * Observer, or a host setting this build has no idea about, survives a
   * round-trip instead of being deleted by whoever saved next.
   */
  [extra: string]: unknown
}

/**
 * What an employee should run on one host.
 *
 * Every field but `host` is optional, and an omitted `model` means the same
 * thing it always did: inherit whatever the session is already running.
 *
 * The index signature matches `SeatSpec`'s, for the same reason — hosts grow
 * options faster than Observer grows releases, and a key we do not understand
 * must survive a save rather than be deleted out from under the user.
 */
export interface SeatTarget {
  /**
   * A `HostKind`. Typed `string` because an unrecognised value must survive
   * the save and be reported (`unknown-host`), exactly like an unknown
   * employee id; a `HostKind`-typed field would have to drop it at parse time
   * and the user would watch their typo disappear instead of being told
   * about it.
   */
  host: string
  /** Opaque above the adapter. Not parsed or validated here — see the header. */
  model?: string
  /** Inert without a `model` — see `diagnoseSeats`. */
  options?: SeatTargetOption[]
  [extra: string]: unknown
}

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
  /**
   * Legacy OpenCode model, `providerID/modelID`.
   *
   * Superseded by `targets`, and kept because existing configs are full of it.
   * Read it through `seatTargets`, not directly, so a caller cannot end up
   * honouring it while `targets` says something else.
   */
  model?: string
  /** Legacy OpenCode reasoning effort. Superseded by `targets`. */
  variant?: string
  /** Extra skills folded into the employee's profile at match time. */
  skills?: EmployeeSkill[]
  /**
   * Per-host configuration, keyed by the provider instance id the target
   * belongs to (`opencode:default`, `codex:work`).
   *
   * Absent — not empty — is what every config written before this change has,
   * and it is the signal `seatTargets` uses to fall back to `model`/`variant`.
   * An explicitly empty `targets: {}` therefore means "this employee is
   * configured for no host", which is a different statement.
   */
  targets?: Record<string, SeatTarget>
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
 * A single `{ id, value }` pair, with anything else on the object kept.
 *
 * `.passthrough()` and not a bare object: hosts grow options faster than
 * Observer ships, and a TUI that round-trips the config would otherwise delete
 * a key it had merely never heard of. `{ id: "x", value: "high", future: 42 }`
 * keeps `future`.
 */
const SeatTargetOptionSchema: z.ZodType<SeatTargetOption, z.ZodTypeDef, unknown> = z
  .object({
    id: z.string().min(1),
    value: z.union([z.string(), z.boolean()]),
  })
  .passthrough()

/**
 * Per-element fallback, because `z.array(...).catch(undefined)` is not it: one
 * malformed option would take the whole list with it, and a user who
 * fat-fingers a Cursor toggle would lose their Cursor model settings alongside
 * it.
 *
 * A failed element is kept *verbatim* rather than dropped. Dropping it would
 * be the same data loss one step down: the user opens the TUI to fix a typo in
 * one option and the option is gone, with nothing left to fix. So the list
 * that comes out is "every entry the user wrote", and reading a value off one
 * is the adapter's job — every consumer already guards, because the array can
 * hold an entry from a newer Observer either way. `diagnoseSeats` reports the
 * bad ones as `malformed-option`.
 */
const SeatTargetOptionsSchema = z
  .array(z.unknown())
  .transform((entries) =>
    entries.map((entry) => {
      const parsed = SeatTargetOptionSchema.safeParse(entry)
      return parsed.success ? parsed.data : (entry as SeatTargetOption)
    }),
  )
  .optional()
  .catch((ctx) => ctx.input as SeatTargetOption[] | undefined)

/**
 * `host` falls back to the empty string rather than to the target's key.
 *
 * Deriving it from `opencode:default` would be a guess: the key is
 * user-chosen, it is free to be `work` or `main`, and a wrong guess would seat
 * a delegation on an adapter the user never named. An empty host parses, is
 * preserved, and is reported as `unknown-host`.
 *
 * The object-level `.catch()` hands back whatever it was given instead of
 * substituting a shape. `targets.t: 7` used to become `{ host: "" }`, which
 * threw the user's value away and then told them their target named no host —
 * a sentence about a target that never existed. Now the `7` survives the save
 * and `diagnoseSeats` says the entry is not a target. This is the only branch
 * where the parsed type is a promise the runtime does not keep, which is why
 * every reader in this file guards with `typeof === "object"` and why
 * `seatTargets` is the supported way in.
 */
export const SeatTargetSchema = z
  .object({
    host: z.string().min(1).catch(""),
    // Not validated beyond "non-empty string". Model ids are opaque above the
    // adapter; the OpenCode-specific slash rule lives in
    // `diagnoseOpencodeModel`.
    model: z.string().min(1).optional().catch(undefined),
    options: SeatTargetOptionsSchema,
  })
  .passthrough()
  .catch((ctx) => ctx.input as { host: string; [extra: string]: unknown })

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
    // `.optional()` so absent stays distinguishable from empty — absent is
    // what makes `seatTargets` fall back to the legacy `model`/`variant` pair,
    // and defaulting to `{}` would silently un-seat every existing config.
    //
    // The `.catch()` returns the input rather than `undefined`, because
    // declaring this key is what took `targets` out of the surrounding
    // `.passthrough()`: a `targets: "sentinel"` that survived every release
    // before this one would have started disappearing on the next save.
    // Declaring a field must never be the thing that makes a config lossy.
    targets: z
      .record(z.string(), SeatTargetSchema)
      .optional()
      .catch((ctx) => ctx.input as Record<string, SeatTarget> | undefined),
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
  /**
   * No longer raised by `diagnoseSeats`. It stays in the union because it is
   * still a real finding — `diagnoseOpencodeModel` returns it, and ticket 02's
   * OpenCode adapter will merge those in — and because dropping it from the
   * union would break every consumer that already filters on it.
   */
  | "malformed-model"
  | "unknown-field"
  | "empty-seat"
  | "control-disabled"
  | "unknown-host"
  | "empty-target"
  | "options-without-model"
  | "legacy-fields-shadowed"
  /**
   * The three "we kept your value but it is not what this field takes"
   * findings, one per level: the whole `targets` map, one target entry, one
   * option in a target's list.
   *
   * `warning` and not `error` in all three cases, deliberately. `error` means
   * the seat cannot work as written, and it is what `ok` — and therefore the
   * CLI's refusal to write agent files — turns on. An `unknown-host` earns
   * that: it is a target that looks right, that the user believes is running,
   * and that no adapter will ever claim. A `targets.t: 7` is visibly junk with
   * nothing configured under it, and letting it block the three good targets
   * beside it would punish the wrong thing.
   */
  | "malformed-targets"
  | "malformed-target"
  | "malformed-option"

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
  /**
   * The target key the finding is scoped to, when it is scoped to one, e.g.
   * `codex:default`. Present so a UI can put the finding on the right row
   * without re-parsing `path` — target keys contain `:` and may contain `.`,
   * so splitting the path back apart is not safe.
   */
  targetId?: string
  /**
   * The host that target names, verbatim, including a value that is not a
   * `HostKind` — that is exactly the case `unknown-host` reports.
   */
  host?: string
  /** One sentence, safe to render verbatim in a TUI or an installer log. */
  message: string
}

/**
 * A `SeatIssue` that is guaranteed to name the target it is about.
 *
 * This is the shape a host adapter returns. `SeatIssue` leaves `employeeId`,
 * `targetId` and `host` optional because the shared, config-wide findings
 * genuinely have nothing to put there — `control-disabled` is about the file,
 * not about anybody's row. An adapter is never in that position: it is handed
 * a profile, a target id and an employee id, so a finding it emits without
 * them is a finding a UI cannot place, and the user is told something is wrong
 * without being told where.
 *
 * Making the three required *here* rather than on `SeatIssue` is what lets one
 * union of codes serve both, and `SeatFinding[]` still satisfies the
 * `SeatIssue[]` that `HostSeatAdapter.diagnose` declares.
 */
export interface SeatFinding extends SeatIssue {
  employeeId: string
  targetId: string
  host: string
}

/**
 * Where a target, or one field of it, lives in the config file.
 *
 * The single owner of this dotted syntax. It exists so an adapter never has to
 * reconstruct `seats.employees.<id>.targets.<targetId>` from string pieces:
 * that is shared config layout, an adapter has no business knowing it, and
 * five adapters each building it by hand is five chances to drift from what
 * the TUI matches on.
 *
 * The field is appended raw rather than escaped. Target ids already contain
 * `:` and may contain `.`, so this path is a human-readable pointer for a
 * message and a stable key for a UI — never something to parse back apart.
 * `SeatIssue.targetId` is there precisely so nobody tries.
 */
export function seatTargetPath(employeeId: string, targetId: string, field?: string): string {
  const base = `seats.employees.${employeeId}.targets.${targetId}`
  return field ? `${base}.${field}` : base
}

export interface SeatDiagnosis {
  /**
   * No `error` findings: every seat named a real employee and every target
   * named a host Observer drives. Unchanged in meaning — the set of rules that
   * can raise an error grew, but `ok` is still "nothing here is dead on
   * arrival".
   */
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
const KNOWN_SEAT_FIELDS = new Set(["model", "variant", "skills", "targets"])

/**
 * The targets a seat actually asks for, with the legacy pair folded in.
 *
 * The one place `model`/`variant` are turned into a target, so no caller has
 * to decide for itself whether a config is old or new — the bug that costs is
 * an adapter honouring `spec.model` on a seat whose `targets` say something
 * else, which is silent and only shows up as the wrong model on a bill.
 *
 * Explicit `targets` win outright when present. They are the newer statement
 * and they are the shape a save writes; treating the leftovers as a fallback
 * per-host would resurrect a model the user had already replaced.
 *
 * Returns a fresh object, never a reference into the config, so a caller
 * cannot mutate a seat by accident.
 */
export function seatTargets(spec: SeatSpec | undefined): Record<string, SeatTarget> {
  if (!spec || typeof spec !== "object") return {}
  if (spec.targets && typeof spec.targets === "object" && !Array.isArray(spec.targets)) {
    return { ...spec.targets }
  }
  const model = typeof spec.model === "string" && spec.model.length > 0 ? spec.model : undefined
  const variant = typeof spec.variant === "string" && spec.variant.length > 0 ? spec.variant : undefined
  if (model === undefined && variant === undefined) return {}
  const target: SeatTarget = { host: "opencode" }
  if (model !== undefined) target.model = model
  // `variant` is OpenCode's own name for the knob, so it stays the option id.
  // Renaming it to something neutral would mean the adapter had to translate
  // back, for no gain: option ids are the host's vocabulary by design.
  if (variant !== undefined) target.options = [{ id: "variant", value: variant }]
  return { [LEGACY_TARGET_ID]: target }
}

/**
 * The seat rewritten in target form, with the legacy pair removed.
 *
 * This is the **only** place `model` and `variant` are dropped, and it is
 * deliberately not on the load path. A config the user has not asked to change
 * must come back off `saveConfig` the way it went in; rewriting it at load
 * would mean opening the TUI to read a value silently rewrote the file, and
 * would strand anyone who rolls Observer back to a build that only reads
 * `model`.
 *
 * A seat that already has `targets`, or that has nothing to migrate, is
 * returned unchanged by identity, so a caller can pass every seat through
 * without checking first.
 */
export function migrateSeatSpecToTargets(spec: SeatSpec): SeatSpec {
  if (spec.targets !== undefined) return spec
  const targets = seatTargets(spec)
  if (Object.keys(targets).length === 0) return spec
  // Rest-destructured rather than `delete`d: the unknown keys the index
  // signature preserves must all survive, and `delete` on a caller's object
  // would mutate the config in place.
  const { model: _model, variant: _variant, ...rest } = spec
  return { ...rest, targets }
}

/**
 * Whether a model id is addressable by OpenCode. OpenCode policy, and the only
 * thing in this file that reads inside a model id.
 *
 * Split out from the finding so the rule itself is one expression an OpenCode
 * adapter can reuse — for a picker's validation, say — without manufacturing a
 * finding it then has to throw away.
 */
export function isOpencodeModelId(model: string): boolean {
  return model.includes("/")
}

/**
 * The `malformed-model` finding for an OpenCode model id, or undefined.
 *
 * Moved out of `diagnoseSeats` because it is OpenCode policy, not a fact about
 * models: `providerID/modelID` is how OpenCode addresses a model, and applying
 * the rule to every host turns Codex's `gpt-5.6-sol` and Grok's `grok-build`
 * — both correct as written — into errors that fail `SeatDiagnosis.ok` and
 * block the whole config. The OpenCode adapter owns the call: it walks its own
 * targets, calls this per model, and merges what comes back into the findings
 * `HostSeatAdapter.diagnose` returns. Shared diagnosis never calls it, because
 * shared diagnosis does not know which host a legacy `model` was written for.
 *
 * The scope carries the *target*, not a path. Handing this function
 * `employeeId` and `targetId` and letting it call `seatTargetPath` is the
 * point: config layout is shared vocabulary and an adapter that assembles a
 * dotted path by hand has taken on a dependency it cannot see change. `path`
 * remains accepted as an override for a caller that genuinely has a different
 * pointer — a picker validating a value not yet in the file, for instance.
 *
 * Returns `SeatFinding`, so `employeeId`, `targetId` and `host` are guaranteed
 * present and a UI can always place the row. The message is unchanged from
 * when it lived in `diagnoseSeats`, so the TUI renders the same sentence it
 * always did.
 */
export function diagnoseOpencodeModel(
  model: string,
  scope: { employeeId: string; targetId: string; field?: string; path?: string },
): SeatFinding | undefined {
  if (model.length === 0 || isOpencodeModelId(model)) return undefined
  return {
    code: "malformed-model",
    severity: "error",
    path: scope.path ?? seatTargetPath(scope.employeeId, scope.targetId, scope.field ?? "model"),
    employeeId: scope.employeeId,
    targetId: scope.targetId,
    host: "opencode",
    message: `"${model}" is missing its provider. Models are written "provider/model", for example "anthropic/claude-opus-4-5".`,
  }
}

/**
 * Reports everything wrong or inert about a seats config, and throws nothing.
 *
 * Pure, so the TUI, the installer and the daemon all reach the same verdict
 * without one of them having to guess. Callers render `issues`; they should
 * not re-derive their own rules.
 *
 * Host-agnostic by construction. Every rule here holds for all five hosts:
 * an id that is not on the roster, a seat or target that sets nothing, an
 * option with no model to apply it to, a host nothing can drive. Anything that
 * needs to know a host's model syntax or its option vocabulary belongs to that
 * host's adapter — see `diagnoseOpencodeModel`.
 *
 * The legacy `model`/`variant` pair is diagnosed on the fields themselves,
 * with the paths and sentences it has always had, rather than through the
 * implicit target `seatTargets` derives from it. Diagnosing the derived target
 * instead would move every existing config's findings to a
 * `targets.opencode:default.…` path the user cannot find in their file.
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
    const targets = spec.targets && typeof spec.targets === "object" && !Array.isArray(spec.targets) ? spec.targets : undefined
    const targetIds = targets ? Object.keys(targets) : []
    // The schema keeps a `targets` that is not a map — a string, a number, an
    // array — rather than deleting it, so this is the only place the user is
    // told. Silently preserving it would be half the bargain: their value is
    // safe and they never find out it does nothing.
    const targetsMalformed = spec.targets !== undefined && targets === undefined

    if (hasVariant && !hasModel && targets === undefined) {
      add(
        "variant-without-model",
        "warning",
        "variant",
        `Reasoning effort "${spec.variant}" has no effect without a model: OpenCode applies a variant only to an agent's own configured model. Set a model, or drop the variant.`,
      )
    }

    if (hasVariant && targets === undefined && !isRecognisedVariant(spec.variant!)) {
      add(
        "unrecognised-variant",
        "warning",
        "variant",
        `"${spec.variant}" is not a reasoning effort Observer recognises (${SEAT_VARIANTS.join(", ")}). Models accept different subsets, so this may still work — the host has the final say.`,
      )
    }

    // Not `unknown-field`: `model` and `variant` are fields Observer applies,
    // they are simply outranked here. Saying "Observer does not apply this
    // yet" would be untrue and would send the user looking for a typo. What
    // they need to know is that the value is dead but still in the file.
    if (targets !== undefined && (hasModel || hasVariant)) {
      add(
        "legacy-fields-shadowed",
        "info",
        "",
        `This seat has "targets", so the older "model" and "variant" fields are ignored. They stay in the file until you save from a target editor.`,
      )
    }

    if (targetsMalformed) {
      add(
        "malformed-targets",
        "warning",
        "targets",
        `"targets" must be a map of target id to target, so this value is ignored. It is preserved in the file so you can correct it${hasModel || hasVariant ? `; the older "model" and "variant" fields are what apply until you do` : ""}.`,
      )
    }

    for (const targetId of targetIds) {
      const raw = targets?.[targetId]
      const isTarget = Boolean(raw) && typeof raw === "object" && !Array.isArray(raw)
      const target: SeatTarget = isTarget ? (raw as SeatTarget) : { host: "" }
      const host = isTarget && typeof target.host === "string" ? target.host : ""
      const targetModel = typeof target.model === "string" && target.model.length > 0 ? target.model : undefined
      const options = Array.isArray(target.options) ? target.options : []
      const addTarget = (code: SeatIssueCode, severity: SeatIssueSeverity, suffix: string, message: string): void => {
        issues.push({
          code,
          severity,
          path: seatTargetPath(id, targetId, suffix || undefined),
          employeeId: id,
          targetId,
          host,
          message,
        })
      }

      // One row per mistake. An entry that is not an object has no host to be
      // wrong about, and stacking `unknown-host` on top would have the TUI
      // explain a target that was never there.
      if (!isTarget) {
        addTarget(
          "malformed-target",
          "warning",
          "",
          "This is not a target, so it is ignored. It is preserved in the file so you can correct it.",
        )
        continue
      }

      // An error, not a warning: no adapter will ever claim this target, so
      // everything configured under it is dead. Same reasoning as
      // `unknown-employee` — reported loudly, kept in the file so the user can
      // fix the spelling rather than retype the target.
      if (!isHostKind(host)) {
        addTarget(
          "unknown-host",
          "error",
          "host",
          host.length === 0
            ? `This target names no host, so nothing can run it. Set "host" to one of: ${HOST_KINDS.join(", ")}.`
            : `"${host}" is not a host Observer drives, so this target is never used. Use one of: ${HOST_KINDS.join(", ")}.`,
        )
      }

      // Options are kept verbatim rather than filtered, so the bad ones are
      // still in the array every rule below counts. Reported once each, by
      // index, because an option list has no other stable handle — ids are the
      // thing that may be missing.
      for (const [index, option] of options.entries()) {
        if (option && typeof option === "object" && !Array.isArray(option) && typeof option.id === "string" && option.id.length > 0) {
          if (typeof option.value === "string" || typeof option.value === "boolean") continue
          addTarget(
            "malformed-option",
            "warning",
            `options.${index}.value`,
            `Option "${option.id}" has a value that is neither text nor a switch, so it is ignored. It is preserved in the file so you can correct it.`,
          )
          continue
        }
        addTarget(
          "malformed-option",
          "warning",
          `options.${index}`,
          "This is not an option, so it is ignored. It is preserved in the file so you can correct it.",
        )
      }

      // The host-agnostic half of the old `variant-without-model` rule. Every
      // host resolves its options against the model it was given; with no
      // model the target inherits the session's, and the options are silently
      // discarded rather than applied to it.
      if (targetModel === undefined && options.length > 0) {
        addTarget(
          "options-without-model",
          "warning",
          "options",
          `${options.length === 1 ? `Option "${describeOption(options[0])}" has` : `These ${options.length} options have`} no effect without a model: a target's options apply only to the model that target sets. Set a model, or drop the options.`,
        )
      }

      if (targetModel === undefined && options.length === 0) {
        addTarget("empty-target", "info", "", "This target sets nothing, so it changes nothing.")
      }
    }

    for (const field of Object.keys(spec)) {
      if (KNOWN_SEAT_FIELDS.has(field)) continue
      add("unknown-field", "info", field, `Observer does not apply "${field}" yet. It is preserved in the file untouched.`)
    }

    if (!hasModel && !hasVariant && skillCount === 0 && targetIds.length === 0) {
      add("empty-seat", "info", "", "This seat sets nothing, so it changes nothing.")
    }

    // `controllable` keeps its meaning — "this seat names a model Observer
    // could act on" — and is derived through `seatTargets` so there is one
    // definition of which model a seat asks for. Counting the legacy fields
    // and the targets separately would double-count a half-migrated seat and
    // inflate the `control-disabled` sentence.
    const asked = Object.values(seatTargets(spec))
    if (asked.some((target) => typeof target?.model === "string" && target.model.length > 0)) controllable += 1
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
 * An option's id for a message, when the option may not have one.
 *
 * Now that malformed entries stay in the list rather than being filtered out,
 * the single-option branch of `options-without-model` can be handed one. A
 * literal `"undefined"` in a sentence the TUI renders verbatim is the failure
 * this prevents.
 */
function describeOption(option: SeatTargetOption | undefined): string {
  const id = option && typeof option === "object" ? option.id : undefined
  return typeof id === "string" && id.length > 0 ? id : "?"
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

/**
 * Reading and rewriting a seat's host targets.
 *
 * Pure, and deliberately free of anything that decides whether a target is
 * *wrong*. That verdict belongs to `diagnoseSeats` and arrives on
 * `config.diagnosis`; a second opinion computed in the browser would drift from
 * the daemon's the first time either changed, and the user would be told two
 * different things about one file.
 *
 * Three invariants everything here holds to, because a settings page that
 * round-trips a hand-edited config is the easiest place in the product to lose
 * somebody's work:
 *
 *  - **Unknown keys survive.** `SeatSpec`, `SeatTarget` and `SeatTargetOption`
 *    all carry index signatures, the daemon's schema preserves them on purpose,
 *    and every rewrite below is a spread rather than a rebuild.
 *  - **A cleared field is deleted, not set to `undefined`.** A key holding
 *    `undefined` reads as present to `Object.keys` and vanishes in
 *    `JSON.stringify`, and one of those two would be wrong.
 *  - **A model id is opaque.** Nothing here parses one. `provider/model` is
 *    OpenCode's addressing scheme, and applying it to Codex's `gpt-5.6-sol`
 *    would reject an id that is exactly right.
 */

import type { ModelOptionDescriptor, SeatSpec, SeatTarget, SeatTargetOption } from "../../api"

/**
 * The target id the legacy top-level `model`/`variant` pair is read as.
 * Mirrors `LEGACY_TARGET_ID` in `apps/daemon/src/seats.ts`.
 */
export const LEGACY_TARGET_ID = "opencode:default"

export interface TargetRow {
  id: string
  target: SeatTarget
  /**
   * True when this row is the legacy `model`/`variant` pair read as a target
   * rather than something the user wrote under `targets`. The editor says so,
   * because saving from here rewrites those two fields away.
   */
  derived: boolean
}

/**
 * The targets a seat actually asks for, with the legacy pair folded in.
 *
 * A structural copy of `seatTargets` in `apps/daemon/src/seats.ts`, and the one
 * place the browser turns `model`/`variant` into a target — so no component has
 * to decide for itself whether a config is old or new. Explicit `targets` win
 * outright when present: they are the newer statement and the shape a save
 * writes, and treating the leftovers as a per-host fallback would resurrect a
 * model the user had already replaced.
 */
export function readTargets(spec: SeatSpec | undefined): Record<string, SeatTarget> {
  if (!spec || typeof spec !== "object") return {}
  if (spec.targets && typeof spec.targets === "object" && !Array.isArray(spec.targets)) {
    return { ...spec.targets }
  }
  const model = nonEmpty(spec.model)
  const variant = nonEmpty(spec.variant)
  if (model === undefined && variant === undefined) return {}
  const target: SeatTarget = { host: "opencode" }
  if (model !== undefined) target.model = model
  // `variant` is OpenCode's own name for the knob, so it stays the option id.
  if (variant !== undefined) target.options = [{ id: "variant", value: variant }]
  return { [LEGACY_TARGET_ID]: target }
}

/**
 * The rows a seat renders, in a stable order.
 *
 * Sorted by id rather than by insertion, because `Object.keys` order on a
 * hand-edited JSON file is whatever the user's editor left behind, and a list
 * that reshuffles when a target is edited is a list nobody can scan.
 */
export function targetRows(spec: SeatSpec | undefined): TargetRow[] {
  const derived = spec?.targets === undefined
  const targets = readTargets(spec)
  return Object.keys(targets)
    .sort((left, right) => left.localeCompare(right))
    .map((id) => ({ id, target: targets[id] as SeatTarget, derived }))
}

/**
 * Whether an entry from a hand-edited config is shaped like a target at all.
 *
 * The daemon's schema keeps `targets.t: 7` rather than deleting it and reports
 * `malformed-target`. The editor has to survive rendering one, so every read
 * below goes through this.
 */
export function isTarget(value: unknown): value is SeatTarget {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function targetHost(target: SeatTarget | undefined): string {
  return typeof target?.host === "string" ? target.host : ""
}

export function targetModel(target: SeatTarget | undefined): string | undefined {
  return nonEmpty(target?.model)
}

/** Only the options a host could act on. Malformed entries are left in the config. */
export function targetOptions(target: SeatTarget | undefined): SeatTargetOption[] {
  const options = Array.isArray(target?.options) ? target.options : []
  return options.filter(
    (option): option is SeatTargetOption =>
      Boolean(option) &&
      typeof option === "object" &&
      typeof option.id === "string" &&
      option.id.length > 0 &&
      (typeof option.value === "string" || typeof option.value === "boolean"),
  )
}

export function optionValue(target: SeatTarget | undefined, id: string): string | boolean | undefined {
  return targetOptions(target).find((option) => option.id === id)?.value
}

/** A target that sets nothing sets nothing, whichever host it names. */
export function isEmptyTarget(target: SeatTarget | undefined): boolean {
  if (!isTarget(target)) return true
  return targetModel(target) === undefined && (Array.isArray(target.options) ? target.options.length : 0) === 0
}

/**
 * One option written, or removed when the value is unset.
 *
 * Order is preserved for the options that stay, because the order a target
 * lists its options is the order the controls were drawn in, and reordering
 * them on every keystroke would make a diff of the config file unreadable.
 * Unknown keys on the option object ride along in the spread.
 */
export function setOption(target: SeatTarget, id: string, value: string | boolean | undefined): SeatTarget {
  const existing = Array.isArray(target.options) ? target.options : []
  const cleared = value === undefined || value === ""
  const next = cleared
    ? existing.filter((option) => !isOptionNamed(option, id))
    : existing.some((option) => isOptionNamed(option, id))
      ? existing.map((option) => (isOptionNamed(option, id) ? { ...option, id, value } : option))
      : [...existing, { id, value }]

  const result: SeatTarget = { ...target }
  if (next.length === 0) delete result.options
  else result.options = next
  return result
}

function isOptionNamed(option: SeatTargetOption | undefined, id: string): boolean {
  return Boolean(option) && typeof option === "object" && option.id === id
}

/**
 * A target pointed at a different model, with the values the new model does not
 * offer cleared.
 *
 * Requirement five of the ticket, and it is not tidiness. A `variant` of `high`
 * carried over onto a model that declares `["none","default"]` is a delegation
 * OpenCode fails outright rather than ignores; a Claude `thinking: true` left
 * on an Opus id is a switch the host has no field for. So changing the model
 * re-derives the descriptors and keeps only what survives them.
 *
 * What survives is judged per descriptor, not per id:
 *
 *  - an id the new descriptors do not mention is dropped,
 *  - a select value that is not one of the new choices is dropped,
 *  - a boolean stays a boolean and a select stays a string; a value of the
 *    wrong type for the descriptor it landed on is dropped.
 *
 * Options Observer does not recognise at all are dropped too, and that is the
 * one deletion in this module. It is safe *because* it only happens on an
 * explicit model change: the user has just told us this target is about a
 * different model, and carrying the previous model's settings forward silently
 * is how a seat ends up billing for a reasoning level nobody chose.
 */
export function retargetModel(
  target: SeatTarget,
  model: string | undefined,
  descriptors: ReadonlyArray<ModelOptionDescriptor>,
): SeatTarget {
  const next: SeatTarget = { ...target }
  if (model === undefined || model.length === 0) delete next.model
  else next.model = model

  const kept = targetOptions(target).filter((option) => {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id)
    if (descriptor === undefined) return false
    if (descriptor.type === "boolean") return typeof option.value === "boolean"
    if (typeof option.value !== "string") return false
    const choices = descriptor.choices ?? []
    return choices.length === 0 || choices.some((choice) => choice.id === option.value)
  })

  if (kept.length === 0) delete next.options
  else next.options = kept
  return next
}

/**
 * A seat with one target written, in target form.
 *
 * This is the only place the legacy `model`/`variant` pair is dropped, and it
 * mirrors `migrateSeatSpecToTargets`: the rewrite happens on a save that is
 * already writing `targets`, never on a read. A config the user has not asked
 * to change must come back off the daemon the way it went in.
 *
 * The other seats are untouched because they are not this function's business —
 * the caller rebuilds `seats.employees` from the freshest config it can reach,
 * for the reason the panel documents.
 */
export function writeTarget(spec: SeatSpec | undefined, targetId: string, target: SeatTarget): SeatSpec {
  const targets = { ...readTargets(spec), [targetId]: target }
  return withTargets(spec, targets)
}

/** A seat with one target removed, keeping every other field. */
export function removeTarget(spec: SeatSpec | undefined, targetId: string): SeatSpec {
  const targets = { ...readTargets(spec) }
  delete targets[targetId]
  return withTargets(spec, targets)
}

function withTargets(spec: SeatSpec | undefined, targets: Record<string, SeatTarget>): SeatSpec {
  // Rest-destructured rather than `delete`d: every unknown key the index
  // signature preserves must survive, and `delete` on the caller's object would
  // mutate the config in place.
  const { model: _model, variant: _variant, ...rest } = spec ?? {}
  const next: SeatSpec = { ...rest }
  // An explicit empty map is a real statement — "configured for no host" — and
  // is kept, so clearing the last target does not silently resurrect a legacy
  // `model` that was only ever shadowed.
  next.targets = targets
  return next
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

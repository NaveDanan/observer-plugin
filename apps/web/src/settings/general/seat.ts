/**
 * Reading and rewriting a seat spec, and the words the seat editor puts around
 * one.
 *
 * Pure, and deliberately free of anything that decides whether a seat is
 * *wrong*. That verdict is `diagnoseSeats`' alone and arrives on
 * `config.diagnosis`; a second opinion computed in the browser would drift
 * from the daemon's the first time either changed, and the user would be told
 * two different things about the same file. The one exception is documented on
 * `malformedModelMessage`, which has a reason it cannot wait for the server.
 */

import type { ModelInfo, ModelVariants, SeatIssue, SeatIssueSeverity, SeatSkill, SeatSpec } from "../../api"
import type { SelectOption } from "../../ui/primitives"

/**
 * Mirrors `SEAT_VARIANTS` in `apps/daemon/src/seats.ts`.
 *
 * Copied rather than imported because the daemon package pulls in fastify and
 * node builtins, exactly as `api.ts` says of the config types. It is used for
 * one thing only — the fallback list when a model does not tell us its effort
 * levels — so a stale copy costs an offer, never a rejection: the daemon still
 * accepts any non-empty string and warns about what it does not recognise.
 */
export const SEAT_VARIANTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

/** The Select value that means "no model" / "no effort". Empty is never a real id. */
export const UNSET = ""

export function seatModel(spec: SeatSpec | undefined): string | undefined {
  return typeof spec?.model === "string" && spec.model.length > 0 ? spec.model : undefined
}

export function seatVariant(spec: SeatSpec | undefined): string | undefined {
  return typeof spec?.variant === "string" && spec.variant.length > 0 ? spec.variant : undefined
}

export function seatSkills(spec: SeatSpec | undefined): SeatSkill[] {
  return Array.isArray(spec?.skills) ? spec.skills : []
}

/** Whether this employee has a seat the user would recognise as configured. */
export function isSeated(spec: SeatSpec | undefined): boolean {
  if (spec === undefined) return false
  return seatModel(spec) !== undefined || seatVariant(spec) !== undefined || seatSkills(spec).length > 0
}

const KNOWN_SEAT_FIELDS = new Set(["model", "variant", "skills"])

/**
 * Whether a seat can be dropped from the config outright.
 *
 * A spec carrying fields Observer does not apply (`temperature`, `permission`)
 * is *not* empty: the daemon preserves those keys on purpose, and deleting the
 * employee's entry to tidy up an empty model would take them with it.
 */
export function isEmptySeat(spec: SeatSpec | undefined): boolean {
  if (spec === undefined) return true
  if (isSeated(spec)) return false
  return Object.keys(spec).every((key) => KNOWN_SEAT_FIELDS.has(key))
}

/**
 * A seat with some fields replaced, on a fresh object.
 *
 * A cleared field is deleted rather than set to `undefined` so that
 * `isEmptySeat` and the JSON that reaches the daemon agree on what the seat
 * contains — a key holding `undefined` reads as present to `Object.keys` and
 * vanishes in `JSON.stringify`, and one of those two would be wrong.
 *
 * Unknown fields ride along in the spread untouched, which is the whole point
 * of the daemon keeping them.
 */
export function patchSeat(
  spec: SeatSpec | undefined,
  patch: { model?: string | undefined; variant?: string | undefined; skills?: SeatSkill[] | undefined },
): SeatSpec {
  const next: SeatSpec = { ...(spec ?? {}) }
  if ("model" in patch) {
    if (patch.model === undefined || patch.model.length === 0) delete next.model
    else next.model = patch.model
  }
  if ("variant" in patch) {
    if (patch.variant === undefined || patch.variant.length === 0) delete next.variant
    else next.variant = patch.variant
  }
  if ("skills" in patch) {
    if (patch.skills === undefined || patch.skills.length === 0) delete next.skills
    else next.skills = patch.skills
  }
  return next
}

/** `200K`, matching the daemon's own context column. */
export function formatContext(window: number | undefined): string | undefined {
  if (window === undefined || window <= 0) return undefined
  if (window >= 1_000_000) return `${Math.round(window / 1_000_000)}M`
  if (window >= 1000) return `${Math.round(window / 1000)}K`
  return String(window)
}

/** `anthropic/claude-opus-4-5 · high · 2 skills`, or undefined for no seat. */
export function seatSummary(spec: SeatSpec | undefined): string | undefined {
  if (!isSeated(spec)) return undefined
  const skills = seatSkills(spec)
  const parts = [
    seatModel(spec) ?? "inherits the session's model",
    seatVariant(spec),
    skills.length > 0 ? `${skills.length} skill${skills.length === 1 ? "" : "s"}` : undefined,
  ]
  return parts.filter((part): part is string => part !== undefined).join(" · ")
}

/**
 * What this seat does once it is saved, in one sentence.
 *
 * Deliberately a description and not a finding: it says what Observer will do
 * with the fields as written, and leaves what is *wrong* with them to the
 * badges carrying `diagnoseSeats`' own messages. The split matters because
 * `control` is off by default, and a preview that read "Arjun runs Opus" while
 * the flag that would make that true was off is the exact lie the terminal UI
 * put fixed chrome at the top of every screen to avoid.
 */
export function seatPreview(spec: SeatSpec | undefined, control: boolean, name: string): string {
  const model = seatModel(spec)
  const variant = seatVariant(spec)
  const skills = seatSkills(spec)
  const sentences: string[] = []

  if (model !== undefined) {
    const effort = variant !== undefined ? ` at ${variant} effort` : ""
    sentences.push(
      control
        ? `OpenCode subagents seated as ${name} run ${model}${effort}.`
        : `${model}${effort} is inert: seat control is off, so the host keeps choosing the model.`,
    )
  } else if (variant !== undefined) {
    sentences.push(`Effort ${variant} has no model to apply to.`)
  }

  if (skills.length > 0) {
    sentences.push(
      `${skills.length} skill${skills.length === 1 ? "" : "s"} ${skills.length === 1 ? "is" : "are"} folded into ${name}'s directive, whether or not seat control is on.`,
    )
  }

  if (sentences.length === 0) return `Nothing is set, so ${name} is seated exactly as the roster describes them.`
  return sentences.join(" ")
}

/**
 * The `malformed-model` sentence, for a model id the user is still typing.
 *
 * The only rule this module applies to a config, and it is here because there
 * is nothing to wait for: the daemon raises `malformed-model` when a seat is
 * saved, but the field should say so while it is being typed rather than after
 * a round trip. The check and the sentence are copied verbatim from
 * `diagnoseSeats` so the two surfaces cannot drift, and a real finding from
 * the daemon still wins wherever one arrives.
 */
export function malformedModelMessage(model: string): string | undefined {
  if (model.length === 0 || model.includes("/")) return undefined
  return `"${model}" is missing its provider. Models are written "provider/model", for example "anthropic/claude-opus-4-5".`
}

export function issuesFor(issues: ReadonlyArray<SeatIssue>, employeeId: string): SeatIssue[] {
  return issues.filter((issue) => issue.employeeId === employeeId)
}

export function badgeVariant(severity: SeatIssueSeverity): "error" | "warning" | "secondary" {
  if (severity === "error") return "error"
  if (severity === "warning") return "warning"
  return "secondary"
}

/**
 * Catalogue entries for the model picker, grouped by provider.
 *
 * Sorted by provider before label because `Select` merges only *consecutive*
 * options that share a group, so an unsorted list would print the same heading
 * once per run of models.
 *
 * `pinned` is the id the seat already names. It is added under its own heading
 * when the catalogue does not contain it, for the reason `observer config`
 * pins it too: a machine with no OpenCode cache lists nothing, and a picker
 * that cannot show the value it is editing looks like it has lost it.
 */
export function modelOptions(
  models: ReadonlyArray<ModelInfo>,
  pinned: string | undefined,
  query: string,
): Array<SelectOption<string>> {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matches = models.filter((model) => {
    if (terms.length === 0) return true
    const haystack = `${model.id} ${model.label} ${model.providerLabel}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
  const sorted = [...matches].sort(
    (left, right) => left.providerLabel.localeCompare(right.providerLabel) || left.label.localeCompare(right.label),
  )

  const options: Array<SelectOption<string>> = [
    { value: UNSET, label: "Inherit the session's model", group: "No model" },
  ]
  if (pinned !== undefined && !models.some((model) => model.id === pinned)) {
    options.push({ value: pinned, label: pinned, group: "Set in your config" })
  }
  for (const model of sorted) {
    const context = formatContext(model.contextWindow)
    options.push({
      value: model.id,
      label: context === undefined ? model.label : `${model.label} · ${context}`,
      group: model.providerLabel,
    })
  }
  return options
}

export interface EffortChoice {
  options: Array<SelectOption<string>>
  disabled: boolean
  /** Why this list is what it is, when that is not obvious. */
  note: string | undefined
}

/**
 * The effort control, driven by the three states of `ModelVariants`.
 *
 * The daemon is deliberate that "this model takes no effort" and "we could not
 * tell" are different answers, so they get different controls: `none` has
 * nothing to offer and says so, `unknown` offers everything Observer knows and
 * admits the host decides. Collapsing them into one empty dropdown would
 * claim we had checked when we had not.
 *
 * `disabled` yields to a value that is already set, in every case. A seat
 * written by hand can carry an effort the model no longer accepts, and a
 * control locked shut around it would leave no way to clear the thing the
 * daemon is warning about.
 */
export function effortChoice(
  model: string | undefined,
  variants: ModelVariants | undefined,
  current: string | undefined,
): EffortChoice {
  const unset: SelectOption<string> = { value: UNSET, label: "No effort", group: "No effort" }
  const pin = (options: Array<SelectOption<string>>): Array<SelectOption<string>> =>
    current !== undefined && !options.some((option) => option.value === current)
      ? [...options, { value: current, label: current, group: "Set in your config" }]
      : options

  if (model === undefined) {
    return {
      options: pin([unset]),
      disabled: current === undefined,
      note: "Choose a model first: OpenCode applies an effort only to an agent's own configured model.",
    }
  }

  if (variants?.kind === "none") {
    return {
      options: pin([unset]),
      disabled: current === undefined,
      note: "This model takes no reasoning effort.",
    }
  }

  if (variants?.kind === "efforts") {
    return {
      options: pin([
        unset,
        ...variants.values.map((value) => ({ value, label: value, group: "Declared by this model" })),
      ]),
      disabled: false,
      note: undefined,
    }
  }

  return {
    options: pin([
      unset,
      ...SEAT_VARIANTS.map((value) => ({ value: value as string, label: value as string, group: "Every level Observer knows" })),
    ]),
    disabled: false,
    note: "Observer could not read this model's effort levels, so this is every level it knows. Models accept different subsets — the host has the final say.",
  }
}

/**
 * Looking a host up, and asking a fetched catalogue what controls a model has.
 *
 * Pure. Everything it reads arrives from `/v1/hosts` or
 * `/v1/hosts/:host/models`; nothing here derives, pads or guesses. The browser
 * used to keep a mirror of the daemon's adapter tables because no endpoint
 * served them — that mirror is gone, and this module is what replaced it: a
 * thin read over the server's answer.
 *
 * The rule the surface turns on survives the change intact: **a descriptor is
 * the only licence to draw a control.** `descriptorsFor` returns a list and a
 * sentence, and `OptionField` draws exactly what is in the list — a boolean as
 * a switch, a select as a select, an empty list as nothing at all. There is no
 * branch anywhere on the *name* of an option, which is what makes `variant`,
 * `reasoningEffort`, `serviceTier`, `effort`, `contextWindow`, `fastMode` and
 * `thinking` one code path instead of seven.
 */

import type { HostCatalogue, HostSummary, ModelOptionDescriptor } from "../../api"
import type { SelectOption } from "../../ui/primitives"
import type { CatalogueState, HostDirectory } from "./hosts"

/** The Select value that means "unset". Empty is never a real id. */
export const UNSET = ""

/**
 * The entry for a host, or undefined when `/v1/hosts` did not list it.
 *
 * Undefined is a real answer and callers must render it rather than falling
 * back to a default host. A hand-edited config can name `cursur`; it can also
 * name `cursor`, which is a real `HostKind` that no adapter in this build
 * claims. Both come back undefined here, and `controlVerdict` is careful to say
 * something true about each.
 */
export function findHost(directory: HostDirectory, host: string): HostSummary | undefined {
  return directory.hosts.find((entry) => entry.id === host)
}

/**
 * A host's display name, from the server, falling back to the raw id.
 *
 * The fallback matters: a target for a host the daemon does not list still has
 * to render, and printing the id the user actually wrote is more useful than
 * printing nothing.
 */
export function hostLabel(directory: HostDirectory, host: string): string {
  return findHost(directory, host)?.label ?? host
}

/**
 * The profile a target id belongs to, split on the first colon.
 *
 * `opencode:default` -> `opencode`. Only the first colon, because the profile
 * half is user-chosen and nothing stops it containing another one.
 */
export function hostOfTargetId(targetId: string): string {
  const colon = targetId.indexOf(":")
  return colon === -1 ? targetId : targetId.slice(0, colon)
}

export function profileOfTargetId(targetId: string): string {
  const colon = targetId.indexOf(":")
  return colon === -1 ? "default" : targetId.slice(colon + 1)
}

/** `OpenCode / default`, the heading a target row carries. */
export function targetTitle(directory: HostDirectory, targetId: string, host: string): string {
  return `${hostLabel(directory, host)} / ${profileOfTargetId(targetId)}`
}

/**
 * The profile id to ask the catalogue endpoint for.
 *
 * A target's key *is* a profile id by construction, so it is sent as-is. The
 * server echoes back the profile it actually answered for, which is how a
 * picker learns it was given the default instead of the `codex:work` it asked
 * about — see `catalogueProfileNote`.
 */
export function profileForTarget(entry: HostSummary | undefined, targetId: string): string | undefined {
  if (entry === undefined) return undefined
  return entry.profiles.some((profile) => profile.id === targetId) ? targetId : undefined
}

export interface DescriptorSet {
  descriptors: ModelOptionDescriptor[]
  /**
   * Why the list is what it is, when that is not self-evident. Rendered
   * verbatim beneath the controls, or in place of them when there are none.
   */
  note: string | undefined
}

/**
 * The controls one target should draw, for one fetched catalogue and one model.
 *
 * Seven answers, and each is a different sentence rather than one empty
 * dropdown, because the states are genuinely different facts:
 *
 *  1. **Not asked yet / in flight.** Say so. A spinner's worth of text beats a
 *     control that appears to offer nothing.
 *  2. **The request failed.** The daemon or the route is the problem, not the
 *     host. Say which, and leave the free-text model field working.
 *  3. **No model chosen.** Every host resolves options against the model it was
 *     given; with none they are discarded. The daemon raises
 *     `options-without-model` for exactly this.
 *  4. **The host listed nothing.** A missing CLI is a healthy 200 here, so the
 *     server's own warning is the sentence to show.
 *  5. **Model not in the list.** The host is the authority on which models
 *     exist; this list is only what Observer read. Offer nothing, because a
 *     descriptor for a model we have never seen would be invented by
 *     definition.
 *  6. **Found, with no options.** `options: []` means "no knobs Observer can
 *     vouch for". Say that; do not draw an empty select.
 *  7. **Found, with options.** Return them, exactly as given.
 */
export function descriptorsFor(state: CatalogueState, hostName: string, model: string | undefined): DescriptorSet {
  if (state.status === "idle" || state.status === "loading") {
    return { descriptors: [], note: `Reading ${hostName}'s model list…` }
  }
  if (state.status === "error") {
    return {
      descriptors: [],
      note: `Observer could not read ${hostName}'s model list, so it cannot say what options this model takes: ${state.error}`,
    }
  }
  if (model === undefined) {
    return {
      descriptors: [],
      note: "Choose a model first: a target's options apply only to the model that target sets.",
    }
  }
  const { catalogue } = state
  if (catalogue.models.length === 0) {
    return { descriptors: [], note: catalogueNote(catalogue) }
  }
  const found = catalogue.models.find((candidate) => candidate.id === model)
  if (found === undefined) {
    return {
      descriptors: [],
      note: `${catalogue.label} did not list "${model}", so Observer has nothing to say about its options. That is a gap in what Observer read, not a verdict on the model — the host is the authority on which models exist.`,
    }
  }
  if (found.options.length === 0) {
    return {
      descriptors: [],
      note: `${catalogue.label} describes no options for ${found.label}. That is the host's answer, not a missing feature.`,
    }
  }
  return { descriptors: found.options, note: undefined }
}

/**
 * What a catalogue is worth, in the server's own vocabulary.
 *
 * `freshness` replaced a set of labels the browser used to invent for itself
 * (`live`, `mirrored`, `declared`, `unclaimed`) back when it was padding the
 * host list out of a local mirror. The server says `live | cached | unknown`,
 * and that is now the only vocabulary on screen.
 */
export function freshnessLabel(freshness: HostCatalogue["freshness"]): string {
  if (freshness === "live") return "read live"
  if (freshness === "cached") return "from a cache"
  return "source unknown"
}

/**
 * One sentence about where a list came from, or why there is none.
 *
 * The server's `warnings` come first and are rendered verbatim — a missing CLI
 * produces exactly the sentence the user needs and the browser has no business
 * rewording it.
 */
export function catalogueNote(catalogue: HostCatalogue): string {
  if (catalogue.warnings.length > 0) return catalogue.warnings.join(" ")
  if (catalogue.models.length === 0) {
    return `${catalogue.label} listed no models. Type a model id below — the host is the authority on which ones exist.`
  }
  return `${catalogue.models.length} model${catalogue.models.length === 1 ? "" : "s"}, ${freshnessLabel(catalogue.freshness)} from ${catalogue.source}.`
}

/**
 * Whether the server answered for a different profile than was asked about.
 *
 * The endpoint echoes `profile` precisely so a picker can notice this. It
 * happens when a target's key is not a profile the host reports — a
 * `codex:work` in the config on a machine with only the default install — and
 * a user staring at a list of models that belong to a different account
 * deserves to be told.
 */
export function catalogueProfileNote(catalogue: HostCatalogue, targetId: string): string | undefined {
  if (catalogue.profile === targetId) return undefined
  if (catalogue.profile.length === 0) {
    return `${catalogue.label} could not name a profile for this target, so the list below may not be the one this target would use.`
  }
  return `This target is filed under "${targetId}", but ${catalogue.label} answered for "${catalogue.profile}". The models below are that profile's.`
}

/** `200K`, matching the daemon's own context column. */
export function formatContext(window: number | undefined): string | undefined {
  if (window === undefined || window <= 0) return undefined
  if (window >= 1_000_000) return `${Math.round(window / 1_000_000)}M`
  if (window >= 1000) return `${Math.round(window / 1000)}K`
  return String(window)
}

/**
 * Catalogue entries for a target's model picker.
 *
 * `pinned` is the id the target already names. It is added under its own
 * heading when the catalogue does not contain it, for the reason the terminal
 * UI pins it too: a machine with no OpenCode cache lists nothing, and a picker
 * that cannot show the value it is editing looks like it has lost it.
 *
 * The list is sorted by label so `Select`, which merges only *consecutive*
 * options sharing a group, prints each heading once.
 */
export function modelOptions(
  state: CatalogueState,
  pinned: string | undefined,
  query: string,
): Array<SelectOption<string>> {
  const models = state.status === "ready" ? state.catalogue.models : []
  const options: Array<SelectOption<string>> = [
    { value: UNSET, label: "Inherit the session's model", group: "No model" },
  ]
  if (pinned !== undefined && !models.some((model) => model.id === pinned)) {
    options.push({ value: pinned, label: pinned, group: "Set in your config" })
  }
  if (models.length === 0) return options

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const matches = models.filter((model) => {
    if (terms.length === 0) return true
    const haystack = `${model.id} ${model.label}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
  const group = state.status === "ready" ? `${state.catalogue.label} models` : "Models"
  for (const model of [...matches].sort(
    (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
  )) {
    const context = formatContext(model.contextWindow)
    options.push({
      value: model.id,
      label: context === undefined ? model.label : `${model.label} · ${context}`,
      group,
    })
  }
  return options
}

/**
 * The choices for one select descriptor, plus whatever the config already
 * holds.
 *
 * A value the descriptor does not offer is pinned rather than dropped. A seat
 * written by hand can carry an effort the model no longer accepts, and a
 * control that silently omitted it would leave no way to clear the very thing
 * the daemon is warning about.
 */
export function optionChoices(
  descriptor: ModelOptionDescriptor,
  current: string | boolean | undefined,
): Array<SelectOption<string>> {
  const options: Array<SelectOption<string>> = [{ value: UNSET, label: "Unset", group: "Unset" }]
  for (const choice of descriptor.choices ?? []) {
    options.push({
      value: choice.id,
      label: choice.isDefault === true ? `${choice.label} · host default` : choice.label,
      group: "Offered by this model",
    })
  }
  if (typeof current === "string" && current.length > 0 && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: current, group: "Set in your config" })
  }
  return options
}

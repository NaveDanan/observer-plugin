import {
  type ListModelsOptions,
  type ModelInfo,
  type ModelVariants,
  catalogueCachePath,
  describeCatalogue,
  listModels,
  variantsFor,
} from "../models.js"
import { LEGACY_TARGET_ID, SEAT_VARIANTS, type SeatIssue, type SeatTarget, type SeatTargetOption, diagnoseOpencodeModel } from "../seats.js"
import type {
  CatalogueModel,
  HostCapabilities,
  HostProfile,
  HostSeatAdapter,
  ModelCatalogue,
  ModelOptionDescriptor,
} from "./types.js"

/**
 * The OpenCode host adapter: everything Observer knows that is true of
 * OpenCode and of nothing else.
 *
 * This is the first adapter and it is deliberately an extraction rather than a
 * rewrite. Every rule below already shipped, somewhere less defensible:
 *
 *  - the `provider/model` slash rule used to be a `.includes("/")` in the
 *    shared seat schema, where it failed Codex's `gpt-5.6-sol` and Grok's
 *    `grok-build` — both correct as written — and blocked the whole config;
 *  - the variant-versus-model check used to be a closure inside the CLI's
 *    `seat-agents.ts`, which is the module that writes files and had no
 *    business also owning what a model declares;
 *  - the catalogue's three-state effort logic had no consumer that could
 *    describe it to a UI in host-neutral terms.
 *
 * They now sit behind one interface, so the Codex, Claude, Cursor and Grok
 * adapters can each answer the same four questions with their own vocabulary
 * and the callers above them stop branching on host names.
 *
 * ## What OpenCode can actually do
 *
 * The task tool takes no `model` parameter. The only lever is `subagent_type`
 * -> agent definition -> `model`, so control means generating a hidden
 * per-employee agent file and rewriting the delegation's `subagent_type` at
 * `tool.execute.before`. That works, which is why `childModel` is
 * `"supported"` here and nowhere else yet — and it works only after a restart,
 * because agent definitions are read once at startup, which is why
 * `requiresReload` is true.
 *
 * ## Cost
 *
 * The catalogue is `~/.cache/opencode/models.json`: about 4 MB and about 80 ms
 * to parse. An adapter instance reads it at most once, lazily, and only when
 * some target actually pairs a model with a variant — a config with no efforts
 * set pays nothing. Instances are cheap and hold that memo for their own
 * lifetime, so a caller reconciling a whole config should build one adapter for
 * the run rather than reuse a long-lived singleton whose snapshot would go
 * stale and never be re-read.
 */

/** OpenCode's own name for the reasoning-effort knob. */
export const OPENCODE_VARIANT_OPTION = "variant"

/** The profile id every OpenCode install has, matching `LEGACY_TARGET_ID`. */
export const OPENCODE_DEFAULT_PROFILE = LEGACY_TARGET_ID

/**
 * A target decoded into the two fields an OpenCode agent definition carries.
 *
 * The point of the type is that decoding happens exactly once, here. A caller
 * that reached into `target.options` looking for `variant` itself would be
 * doing the adapter's job with none of its rules — dropping a boolean value,
 * ignoring a duplicate id, requiring the host to match — and would drift the
 * moment OpenCode grows a second option.
 */
export interface OpencodeSeatTarget {
  /** Non-empty. A target with no model has nothing to apply and is not decoded. */
  model: string
  /** Absent when the target sets no reasoning effort. */
  variant?: string
}

export interface OpencodeAdapterOptions {
  /**
   * Model ids to pin into the catalogue whatever the auth file says.
   *
   * Callers pass the models their config already names. Without it a user
   * whose Anthropic key has lapsed gets a catalogue that has demonstrably
   * heard of their model but does not list it, and every check that consults
   * it goes quiet exactly when it still had something true to say.
   */
  include?: string[]
  /**
   * How the catalogue is read. Defaults to `listModels`.
   *
   * A seam for tests and for a future caller that already holds a probed list
   * and should not pay for a second 4 MB parse.
   */
  readModels?: (options: ListModelsOptions) => ModelInfo[]
  /**
   * The profiles this adapter serves. Defaults to the single default install.
   *
   * Injected rather than read from `config.providers` because the adapter is
   * pure: it never loads Observer's own config, so a caller can build one for
   * a config parsed on another machine.
   */
  profiles?: HostProfile[]
}

const DEFAULT_PROFILES: HostProfile[] = [{ id: OPENCODE_DEFAULT_PROFILE, host: "opencode", label: "OpenCode" }]

/**
 * The model and reasoning effort a target asks OpenCode for, or undefined when
 * it asks for nothing this adapter can act on.
 *
 * Undefined for three separate reasons, all of which mean "write no agent
 * definition": the target belongs to another host, it names no model, or it is
 * not an object at all. They are not distinguished because the caller's
 * response to all three is identical; anything that is *wrong* rather than
 * merely absent comes back from `diagnose` instead, with a sentence.
 */
export function readOpencodeTarget(target: SeatTarget | undefined): OpencodeSeatTarget | undefined {
  if (!target || typeof target !== "object" || Array.isArray(target)) return undefined
  if (target.host !== "opencode") return undefined
  const model = typeof target.model === "string" && target.model.length > 0 ? target.model : undefined
  if (model === undefined) return undefined
  const resolved: OpencodeSeatTarget = { model }
  const variant = readVariant(target.options)
  if (variant !== undefined) resolved.variant = variant
  return resolved
}

/**
 * The `variant` option's value, when it is one OpenCode could use.
 *
 * A boolean is dropped rather than stringified. `variant` names an effort
 * level and the host validates it against the model's resolved variant map, so
 * `variant: "true"` would not be a lenient reading of a mistyped toggle — it
 * would be a value guaranteed to fail the delegation, written into the
 * frontmatter as if the user had asked for it.
 */
function readVariant(options: SeatTargetOption[] | undefined): string | undefined {
  if (!Array.isArray(options)) return undefined
  for (const option of options) {
    if (!option || typeof option !== "object" || option.id !== OPENCODE_VARIANT_OPTION) continue
    return typeof option.value === "string" && option.value.length > 0 ? option.value : undefined
  }
  return undefined
}

export function createOpencodeAdapter(options: OpencodeAdapterOptions = {}): HostSeatAdapter {
  const read = options.readModels ?? listModels
  const include = options.include?.filter((id) => typeof id === "string" && id.length > 0) ?? []
  const profiles = options.profiles ?? DEFAULT_PROFILES

  /**
   * The catalogue, read at most once per adapter and never before it is
   * needed. `undefined` means "not read yet"; an empty array is a real answer
   * and must not trigger a second read.
   */
  let snapshot: ModelInfo[] | undefined
  const models = (): ModelInfo[] => {
    if (snapshot === undefined) snapshot = read(include.length > 0 ? { include } : {})
    return snapshot
  }

  return {
    kind: "opencode",
    label: "OpenCode",

    profiles: () => profiles.map((profile) => ({ ...profile })),

    catalogue(profileId: string): ModelCatalogue {
      const list = models()
      const warnings: string[] = []
      // One catalogue per machine: OpenCode's snapshot lives at a fixed cache
      // path and a second profile pointed at a different `homePath` still
      // reads the same models.dev dump. `profileId` therefore selects nothing
      // today, and saying so beats silently answering for a profile that does
      // not exist.
      if (!profiles.some((profile) => profile.id === profileId)) {
        warnings.push(
          `"${profileId}" is not a configured OpenCode profile, so this list is the one every OpenCode install shares.`,
        )
      }
      if (list.length === 0) warnings.push(describeCatalogue(list))
      return {
        models: list.map(toCatalogueModel),
        source: catalogueCachePath(),
        // Never `live`: the only live source is `opencode models --verbose`,
        // which costs seconds of subprocess and is opt-in one level down. A
        // caller that probed and handed the result in through `readModels`
        // still gets `cached`, because this adapter cannot tell the difference
        // and guessing `live` would be the kind of overclaim `freshness`
        // exists to prevent.
        freshness: list.length > 0 ? "cached" : "unknown",
        warnings,
      }
    },

    diagnose(_profileId: string, targetId: string, target: SeatTarget, employeeId: string): SeatIssue[] {
      const resolved = readOpencodeTarget(target)
      if (!resolved) return []
      const path = `seats.employees.${employeeId}.targets.${targetId}`

      // The slash rule first, and on its own. A model id that is not
      // addressable cannot be looked up in the catalogue either, so reporting
      // a variant finding beside it would be two sentences about one broken
      // value — and would pay for a 4 MB parse to say the second.
      const malformed = diagnoseOpencodeModel(resolved.model, { path: `${path}.model`, employeeId, targetId })
      if (malformed) return [malformed]

      if (resolved.variant === undefined) return []
      const undeclared = diagnoseVariant(models(), resolved.model, resolved.variant, {
        path: `${path}.options`,
        employeeId,
        targetId,
      })
      return undeclared ? [undeclared] : []
    },

    capabilities: (_profileId: string): HostCapabilities => ({
      // The disk snapshot is the default and the only one that costs nothing.
      // `listModels({ probeHost: true })` upgrades it to the host's own answer,
      // but it is opt-in and seconds slow, so it is not what this adapter
      // promises by default.
      discovery: "cached",
      // The whole reason OpenCode is the first adapter: generated agent
      // definitions plus the `general`-only `subagent_type` rewrite genuinely
      // make a delegated child run a chosen model.
      childModel: "supported",
      // `variant` rides the same generated definition and the host honours it,
      // subject to the model declaring it — which is what `diagnose` checks
      // before a file is ever written.
      childReasoning: "supported",
      // Agent definitions are read once at startup. A file written now does
      // nothing until OpenCode restarts, and a UI that does not say so leaves
      // the user watching a setting apparently fail.
      requiresReload: true,
    }),
  }
}

/**
 * The registry's OpenCode entry.
 *
 * Safe for `profiles`, `capabilities` and a one-off `catalogue`. Not the thing
 * to reconcile a whole config with: it lives for the process and its catalogue
 * memo would too. Build a fresh `createOpencodeAdapter({ include })` for that.
 */
export const opencodeAdapter: HostSeatAdapter = createOpencodeAdapter()

/**
 * The refusal to seat a variant the model does not declare, or undefined.
 *
 * Lifted verbatim — sentences included — from the closure that used to live in
 * the CLI's `seat-agents.ts`, because the wording is load-bearing: the TUI and
 * the installer both render findings without rewording them, and two
 * vocabularies for one finding is exactly what this refactor exists to remove.
 *
 * It closes the gap the plugin's existence check cannot. OpenCode validates
 * `variant` per model at *use* time — `if (x.variant && !R.variants?.[x.variant])
 * fail(...)` — so a variant the model does not offer writes a valid file,
 * loads, appears in `GET /agent`, passes the existence check, and only then
 * kills the delegation. An `error` severity is what stops the file being
 * written at all, turning a broken task into a no-op.
 *
 * `unrecognised-variant` rather than a new code: it is the same finding
 * `diagnoseSeats` raises as a warning for an effort nothing in the catalogue
 * has ever heard of, sharpened to an error by a model that has actually ruled
 * on it. Severity is what separates the two, and consumers already filter on
 * it.
 */
function diagnoseVariant(
  models: ModelInfo[],
  model: string,
  variant: string,
  scope: { path: string; employeeId: string; targetId: string },
): SeatIssue | undefined {
  const declared = variantsFor(models, model)
  // `known: false` means the catalogue is absent, corrupt, or has never heard
  // of this model, and `values` is then a guess across every provider. An
  // unknown model is not a wrong model: let the host rule.
  if (!declared.known) return undefined

  /**
   * An empty list is a verdict, not silence. `variantsFor` distinguishes "this
   * model takes no reasoning effort" from "we cannot work out which efforts it
   * takes" — the mechanisms OpenCode synthesises variants for, like
   * `budget_tokens`, come back as unknown and are already let through above.
   * So reaching here with an empty list means the host will reject every
   * variant for this model, which is exactly what to refuse.
   */
  const message =
    declared.values.length === 0
      ? `${model} takes no reasoning effort, so "${variant}" cannot apply and no agent definition was written for it. OpenCode fails a delegation whose variant its model does not declare rather than ignoring the variant, so the seat is skipped instead.`
      : declared.values.includes(variant)
        ? undefined
        : `Reasoning effort "${variant}" is not one ${model} offers (${declared.values.join(", ")}), so no agent definition was written for it. OpenCode fails a delegation whose variant its model does not declare rather than ignoring the variant, so the seat is skipped instead.`

  if (message === undefined) return undefined
  return {
    code: "unrecognised-variant",
    severity: "error",
    path: scope.path,
    employeeId: scope.employeeId,
    targetId: scope.targetId,
    host: "opencode",
    message,
  }
}

function toCatalogueModel(info: ModelInfo): CatalogueModel {
  const model: CatalogueModel = { id: info.id, label: info.label, options: variantOptions(info.variants) }
  if (info.contextWindow !== undefined) model.contextWindow = info.contextWindow
  return model
}

/**
 * The `variant` control for one model, from the catalogue's three states.
 *
 * The three states are the whole reason `ModelVariants` is a union, and
 * flattening them into a list here would undo that:
 *
 *  - `efforts` — the model named its levels. Offer exactly those.
 *  - `none`    — the model accepts no variant at all. Offer **no descriptor**,
 *    which is how a UI renders "there is no control here" rather than an empty
 *    dropdown the user can fight with. 3,506 of today's models are in this
 *    state and every one of them rejects every variant.
 *  - `unknown` — we cannot tell, and 940 models are in this state. The list
 *    falls back to `SEAT_VARIANTS`, which is a union across the catalogue and
 *    not a valid-everywhere enum, so the label says the values are a
 *    suggestion and the host keeps the last word.
 *
 * No `isDefault` on any choice: OpenCode has no default effort, and an absent
 * variant means "inherit", which is a different and better answer than any
 * level this could pick.
 */
function variantOptions(variants: ModelVariants): ModelOptionDescriptor[] {
  switch (variants.kind) {
    case "efforts":
      return [descriptor("Reasoning effort", variants.values)]
    case "none":
      return []
    default:
      return [descriptor("Reasoning effort (suggested)", [...SEAT_VARIANTS])]
  }
}

function descriptor(label: string, values: readonly string[]): ModelOptionDescriptor {
  return {
    id: OPENCODE_VARIANT_OPTION,
    label,
    type: "select",
    choices: values.map((value) => ({ id: value, label: value })),
  }
}

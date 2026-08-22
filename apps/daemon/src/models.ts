import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { SEAT_VARIANTS } from "./seats.js"

/**
 * The model catalogue the seat picker offers.
 *
 * Observer does not ship a model list. Shipping one would go stale the week
 * after a release and would then be lying to the user about what their host
 * accepts — the host validates `model` and `variant` at delegation time and
 * fails the whole call when either is wrong. So the catalogue is read from
 * whatever OpenCode already knows, in a fixed order of trust:
 *
 *  1. `~/.cache/opencode/models.json` — the models.dev snapshot OpenCode keeps
 *     on disk. ~4 MB, ~80 ms to parse, ~7 000 models across ~190 providers.
 *     It carries the two things the picker needs and nothing else has:
 *     `limit.context` and `reasoning_options`.
 *  2. `~/.local/share/opencode/auth.json` — key names only, never values. Used
 *     purely to narrow (1) to providers the user can actually reach, which is
 *     the difference between a 7 000-row picker and a 100-row one.
 *  3. `opencode models --verbose` — the host's own answer, and the only source
 *     that accounts for config-declared providers *and* the only one that
 *     knows a model's resolved `variants` map, which is the exact map the task
 *     tool validates a delegation against. It costs a few seconds of
 *     subprocess, so it is opt-in (`probeHost`) rather than the default path.
 *
 * Layer 3 is the only one that can be right about efforts in every case: the
 * host synthesises a model's variants from its family and its provider's SDK,
 * and neither rule is written down on disk. Without it the catalogue can still
 * answer for most models, but it has to admit when it cannot — see
 * `ModelVariants`.
 *
 * Every layer is allowed to be missing. `listModels()` returns `[]` rather
 * than throwing, and the picker falls back to typing a `provider/model` string
 * by hand — which is what a user with an exotic provider needs anyway.
 */

/**
 * What Observer knows about a model's reasoning efforts. Exactly three states.
 *
 * A union rather than `string[]`, because the two ways of having nothing to
 * offer are not the same answer and the bug this shape exists to prevent was
 * precisely their collapse. `{ values: [], known: true }` used to mean both
 * "this model takes no reasoning effort" and "we could not work out what this
 * model takes", and 958 models in today's catalogue were being told the first
 * when the truth was the second. Spelling the states as variants makes that
 * conflation a type error at every read site instead of a judgement call.
 *
 *  - `efforts` — the model accepts exactly these, weakest first. Offer them.
 *  - `none`    — the model accepts no variant at all. Offer none, and say so.
 *  - `unknown` — we cannot tell. Fall back to `SEAT_VARIANTS` and let the host
 *                rule, because a suggestion the user is warned about beats a
 *                confident answer that is wrong.
 */
export type ModelVariants = { kind: "efforts"; values: string[] } | { kind: "none" } | { kind: "unknown" }

export interface ModelInfo {
  /** `providerID/modelID`, exactly as a seat spec stores it. */
  id: string
  provider: string
  /** Human name of the provider, for the picker's group headers. */
  providerLabel: string
  label: string
  contextWindow?: number
  /** The reasoning efforts this model accepts, or why we cannot say. */
  variants: ModelVariants
  /** ISO date, used only to sort newest-first within a provider. */
  releaseDate?: string
  /**
   * Whether the catalogue had a real entry for this id.
   *
   * False when the host listed a model the snapshot has never heard of (there
   * are always a few, e.g. `github-copilot/claude-opus-4.8-fast`). Those are
   * still offered — the host is the authority on what exists — but Observer
   * must not claim to know their effort levels.
   *
   * This is about the *model*, not its efforts: a model can be perfectly well
   * known and still have `variants: { kind: "unknown" }`, which is the whole
   * 958-model case. Read `variants.kind` for anything to do with effort.
   */
  known: boolean
}

/**
 * Providers usable without the user holding a credential for them.
 *
 * OpenCode ships a hosted free tier under its own provider id, so it survives
 * the `auth.json` filter that removes every other unauthenticated provider.
 */
const ALWAYS_REACHABLE = new Set(["opencode"])

export interface CatalogueSources {
  /** Raw text of OpenCode's `models.json`. Malformed input yields no models. */
  catalogue?: string
  /** `provider/model` ids the host reports, e.g. the output of `opencode models`. */
  available?: string[]
  /** Provider ids the user holds credentials for. Narrows the catalogue. */
  authenticated?: string[]
  /**
   * Ids to keep whatever the filters say, with full metadata when the
   * catalogue has it.
   *
   * The seats already in the config go here. Otherwise a user whose Anthropic
   * key has lapsed opens the picker and finds the model they configured
   * missing from a list that demonstrably knows about it — the cursor lands on
   * "inherit" and the context and effort columns go blank.
   */
  include?: string[]
  /**
   * `provider/model` -> the exact variant names the host will accept.
   *
   * Ground truth, and it outranks anything derived from `reasoning_options`.
   * OpenCode resolves each model to a `variants` map at load time and the task
   * tool validates against precisely that map — `if (x.variant &&
   * !R.variants?.[x.variant]) fail(...)` — so when we can read it there is
   * nothing left to infer. `opencode models --verbose` prints it, and so does
   * `GET /provider` on a running server.
   *
   * It is worth the subprocess because the derivation cannot get everything
   * right: the host's synthesis is keyed on the provider's SDK package as well
   * as the model, so a handful of providers (`@aihubmix/ai-sdk-provider`,
   * `@ai-sdk/perplexity`, `gitlab-ai-provider` and friends) accept no variant
   * at all despite their models declaring a full effort scale in models.dev.
   * Nothing on disk distinguishes them; only the host knows.
   */
  variants?: Record<string, readonly string[]>
}

/**
 * Builds the picker's list from raw source text. Pure, and throws nothing.
 *
 * Separated from `listModels` so the merge rules — which source wins, how an
 * unknown id degrades, what gets filtered — are testable without a home
 * directory, a subprocess, or a 4 MB fixture.
 */
export function buildCatalogue(sources: CatalogueSources): ModelInfo[] {
  const providers = parseCatalogue(sources.catalogue)
  const available = sources.available?.filter((id) => id.includes("/")) ?? []

  // The host's own list wins outright when we have it: it is the only source
  // that knows about config-declared providers, and it is never wrong about
  // what this machine can call.
  const listed =
    available.length > 0
      ? available
      : [...providers.values()]
          .filter((provider) => isReachable(provider.id, sources.authenticated))
          .flatMap((provider) => [...provider.models.keys()])

  const pinned = (sources.include ?? []).filter((id) => id.includes("/"))
  const ids = [...pinned, ...listed]

  const models: ModelInfo[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const info = describe(id, providers, sources.variants)
    if (info) models.push(info)
  }

  return models.sort(compareModels)
}

/**
 * Which reasoning efforts to offer for a model, and whether we vouch for them.
 *
 * The three states of `ModelVariants`, flattened for the UI:
 *
 *  - `{ values: [...], known: true }` — offer exactly these.
 *  - `{ values: [],    known: true }` — the model takes no reasoning effort.
 *    The control has nothing to offer and the UI says so in words.
 *  - `{ values: SEAT_VARIANTS, known: false }` — we cannot tell. The
 *    suggestion list is a union across the whole catalogue, not a
 *    valid-everywhere enum, so the UI must present it as a guess and let the
 *    host have the last word.
 *
 * `known` is deliberately *not* `ModelInfo.known`. A model can be in the
 * catalogue and still be a mystery about efforts: models.dev publishes a list
 * of reasoning *mechanisms*, and OpenCode synthesises a variant map from the
 * ones that are not `effort` using rules that depend on the model family and
 * the provider's SDK. Reading an absent `effort` entry as "no efforts" is how
 * 958 models came to be confidently mislabelled.
 *
 * No model still means no effort at all: OpenCode applies a variant only to an
 * agent's own configured model, so offering a scale would be offering a
 * control that provably does nothing.
 */
export function variantsFor(models: ModelInfo[], modelId: string | undefined): { values: string[]; known: boolean } {
  if (!modelId) return { values: [], known: true }
  const variants = models.find((model) => model.id === modelId)?.variants
  if (variants?.kind === "efforts") return { values: [...variants.values], known: true }
  if (variants?.kind === "none") return { values: [], known: true }
  return { values: [...SEAT_VARIANTS], known: false }
}

/** Provider groups in picker order, each already sorted newest-first. */
export function groupByProvider(models: ModelInfo[]): Array<{ provider: string; label: string; models: ModelInfo[] }> {
  const groups: Array<{ provider: string; label: string; models: ModelInfo[] }> = []
  for (const model of models) {
    const last = groups[groups.length - 1]
    if (last && last.provider === model.provider) last.models.push(model)
    else groups.push({ provider: model.provider, label: model.providerLabel, models: [model] })
  }
  return groups
}

export interface ListModelsOptions {
  /** Override the cache location; tests point this at a fixture directory. */
  cachePath?: string
  authPath?: string
  /** Model ids to offer regardless of which providers are reachable. */
  include?: string[]
  /**
   * Shell out to `opencode models`. Off by default because it costs seconds of
   * startup, which is the wrong trade for a list the disk cache already has.
   */
  probeHost?: boolean
}

/**
 * The models to offer, or `[]` when nothing is discoverable.
 *
 * Never throws. An empty result is a supported state, not a failure: the
 * picker switches to free-text entry and `describeCatalogue` explains why.
 */
export function listModels(options: ListModelsOptions = {}): ModelInfo[] {
  const sources: CatalogueSources = {}
  const catalogue = readFileOrUndefined(options.cachePath ?? catalogueCachePath())
  if (catalogue !== undefined) sources.catalogue = catalogue
  const authenticated = readAuthProviders(options.authPath ?? authCachePath())
  if (authenticated.length > 0) sources.authenticated = authenticated
  if (options.include !== undefined && options.include.length > 0) sources.include = options.include
  if (options.probeHost === true) {
    const host = probeHostModels()
    if (host.ids.length > 0) sources.available = host.ids
    if (Object.keys(host.variants).length > 0) sources.variants = host.variants
  }
  try {
    return buildCatalogue(sources)
  } catch {
    return []
  }
}

/** One sentence for the picker to render, whatever the catalogue did. */
export function describeCatalogue(models: ModelInfo[], options: ListModelsOptions = {}): string {
  const path = options.cachePath ?? catalogueCachePath()
  if (models.length > 0) {
    const groups = groupByProvider(models).length
    return `${models.length} models from ${groups} provider${groups === 1 ? "" : "s"}, read from ${path}.`
  }
  if (!existsSync(path)) {
    return `No model catalogue at ${path}, so this list is empty. Run OpenCode once to populate it, or type a model below.`
  }
  return `The model catalogue at ${path} could not be read, so this list is empty. Type a model below instead.`
}

export function catalogueCachePath(): string {
  const base =
    process.env["XDG_CACHE_HOME"] && process.env["XDG_CACHE_HOME"].length > 0
      ? process.env["XDG_CACHE_HOME"]
      : join(homedir(), ".cache")
  return join(base, "opencode", "models.json")
}

export function authCachePath(): string {
  const base =
    process.env["XDG_DATA_HOME"] && process.env["XDG_DATA_HOME"].length > 0
      ? process.env["XDG_DATA_HOME"]
      : join(homedir(), ".local", "share")
  return join(base, "opencode", "auth.json")
}

/**
 * `1048576` -> `1M`, `200000` -> `200K`.
 *
 * Rounded to whole units on purpose: the picker's Context column exists so a
 * user can tell 200K from 1M at a glance, and `1.05M` costs three characters
 * to say nothing extra.
 */
export function formatContext(window: number | undefined): string {
  if (window === undefined || window <= 0) return "-"
  if (window >= 1_000_000) return `${Math.round(window / 1_000_000)}M`
  if (window >= 1000) return `${Math.round(window / 1000)}K`
  return String(window)
}

interface CatalogueProvider {
  id: string
  label: string
  models: Map<string, CatalogueModel>
}

interface CatalogueModel {
  label: string
  contextWindow?: number
  variants: ModelVariants
  releaseDate?: string
  usable: boolean
}

function parseCatalogue(raw: string | undefined): Map<string, CatalogueProvider> {
  const providers = new Map<string, CatalogueProvider>()
  if (raw === undefined || raw.length === 0) return providers
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return providers
  }
  if (!isRecord(parsed)) return providers

  for (const [providerId, entry] of Object.entries(parsed)) {
    if (!isRecord(entry)) continue
    const label = typeof entry["name"] === "string" && entry["name"].length > 0 ? entry["name"] : providerId
    const rawModels = isRecord(entry["models"]) ? entry["models"] : {}
    const models = new Map<string, CatalogueModel>()
    for (const [modelId, model] of Object.entries(rawModels)) {
      if (!isRecord(model)) continue
      // The key is the model id; the composite the seat stores is
      // `provider/model`, and a model id may itself contain a slash.
      models.set(`${providerId}/${modelId}`, readModel(model))
    }
    providers.set(providerId, { id: providerId, label, models })
  }
  return providers
}

function readModel(model: Record<string, unknown>): CatalogueModel {
  const limit = isRecord(model["limit"]) ? model["limit"] : {}
  const context = typeof limit["context"] === "number" ? limit["context"] : undefined
  const result: CatalogueModel = {
    label: typeof model["name"] === "string" && model["name"].length > 0 ? model["name"] : "",
    variants: readVariants(model["reasoning_options"]),
    // A subagent needs tools and a context window. Image and embedding models
    // are in the same catalogue and would only be noise in this picker.
    usable: model["tool_call"] !== false && (context === undefined || context > 0),
  }
  if (context !== undefined && context > 0) result.contextWindow = context
  if (typeof model["release_date"] === "string") result.releaseDate = model["release_date"]
  return result
}

/**
 * What a models.dev `reasoning_options` array lets us conclude about efforts.
 *
 * The array is a list of *mechanisms*, not levels. A model can carry a
 * `toggle`, a `budget_tokens` range and an `effort` scale at once, and only
 * `effort` names the values OpenCode uses as variants. The others do not mean
 * "no variants": the host *synthesises* a variant map for them, from the model
 * family and the provider's SDK, and neither of those rules is on disk.
 *
 * Measured against a live host (`opencode serve` 1.18.21, `GET /provider`,
 * 7 202 models), which reports the resolved map the task tool validates
 * against:
 *
 *   reasoning_options            models   host's answer
 *   -------------------------------------------------------------------
 *   absent, or `[]`               3 506   no variants, every single one
 *   contains `effort`             2 714   the effort values, 2 664 exactly,
 *                                         2 a superset, 48 none at all
 *   mechanisms but no `effort`      940   594 none, 346 synthesised
 *
 * So:
 *
 *  - No mechanisms at all is a real answer. 3 506 for 3 506 — the host offers
 *    nothing, and `gpt-4o` is in this group. `none`.
 *  - An `effort` entry names the values, and wins over any `toggle` or
 *    `budget_tokens` sitting beside it. The 48 exceptions are five exotic SDK
 *    packages that accept no variant whatever the model declares, and nothing
 *    on disk distinguishes them; `sources.variants` is how that gets fixed,
 *    not a guess here.
 *  - Mechanisms without an `effort` entry are a coin flip — 594 against 346 —
 *    so this is the one that must say `unknown`. Answering `none` here is the
 *    bug: it tells the user a `budget_tokens` model takes no effort when the
 *    host would have accepted `high` and `max`.
 *
 * Non-string values are dropped rather than translated. A couple of providers
 * publish a literal `null` where the host renders `"none"`; offering a strict
 * subset costs one level, and inventing a level costs the whole delegation.
 */
function readVariants(options: unknown): ModelVariants {
  if (!Array.isArray(options)) return { kind: "none" }
  for (const option of options) {
    if (!isRecord(option) || option["type"] !== "effort") continue
    const values = option["values"]
    if (!Array.isArray(values)) continue
    const efforts = values.filter((value): value is string => typeof value === "string" && value.length > 0)
    // An `effort` entry that names nothing is the same answer as no mechanism
    // at all, and normalising here keeps `kind: "efforts"` meaning "there is
    // something to offer" everywhere it is read.
    return efforts.length === 0 ? { kind: "none" } : { kind: "efforts", values: efforts }
  }
  return options.length === 0 ? { kind: "none" } : { kind: "unknown" }
}

function describe(
  id: string,
  providers: Map<string, CatalogueProvider>,
  hostVariants: Record<string, readonly string[]> | undefined,
): ModelInfo | undefined {
  const slash = id.indexOf("/")
  if (slash <= 0) return undefined
  const providerId = id.slice(0, slash)
  const provider = providers.get(providerId)
  const model = provider?.models.get(id)

  if (model && !model.usable) return undefined

  const info: ModelInfo = {
    id,
    provider: providerId,
    providerLabel: provider?.label ?? providerId,
    label: model?.label && model.label.length > 0 ? model.label : id.slice(slash + 1),
    // The host's resolved map beats the catalogue outright — it is the same
    // map the task tool validates against, so there is nothing to infer. An id
    // the host did not mention falls back to the derivation, which is what
    // happens for every model when nobody probed.
    variants: resolveVariants(hostVariants?.[id], model?.variants),
    known: model !== undefined,
  }
  if (model?.contextWindow !== undefined) info.contextWindow = model.contextWindow
  if (model?.releaseDate !== undefined) info.releaseDate = model.releaseDate
  return info
}

function resolveVariants(host: readonly string[] | undefined, derived: ModelVariants | undefined): ModelVariants {
  if (host !== undefined) return host.length === 0 ? { kind: "none" } : { kind: "efforts", values: [...host] }
  // No catalogue entry means no derivation either, and that is `unknown`
  // rather than `none`: the host lists models models.dev has never indexed
  // (the `-fast` aliases, mostly) and they routinely do accept efforts.
  return derived ?? { kind: "unknown" }
}

function isReachable(providerId: string, authenticated: string[] | undefined): boolean {
  if (authenticated === undefined) return true
  return ALWAYS_REACHABLE.has(providerId) || authenticated.includes(providerId)
}

/**
 * Providers ordered alphabetically, models newest-first inside each.
 *
 * Newest-first is the whole point: the model a user wants is almost always one
 * of the two most recent from their provider, and an alphabetical list buries
 * `claude-opus-4-8` under `claude-3-haiku`.
 */
function compareModels(a: ModelInfo, b: ModelInfo): number {
  if (a.providerLabel !== b.providerLabel) return a.providerLabel.localeCompare(b.providerLabel)
  if (a.releaseDate !== b.releaseDate) return (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "")
  return a.label.localeCompare(b.label)
}

function readFileOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/**
 * Provider ids out of OpenCode's auth file.
 *
 * Keys only. The values are live access and refresh tokens, and nothing in
 * this module ever reads, stores or renders one.
 */
function readAuthProviders(path: string): string[] {
  const raw = readFileOrUndefined(path)
  if (raw === undefined) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? Object.keys(parsed) : []
  } catch {
    return []
  }
}

/**
 * What the host itself says exists, and what efforts each of those takes.
 *
 * `--verbose` prints the resolved model record as pretty JSON under each
 * `provider/model` line, `variants` map included. That map is the host's final
 * word — the task tool checks `x.variant` against it and fails the whole
 * delegation on a miss — so harvesting it here is what turns the effort column
 * from an inference into a report. It is the same object `GET /provider`
 * serves on a running server, without a port, a process to reap, or an async
 * hop through a module that is synchronous end to end.
 *
 * Ids come from the JSON's own `providerID` and `id`, never from the header
 * line, because a model id may itself contain a slash
 * (`hpc-ai/deepseek/deepseek-v4-flash`) and splitting the header would guess
 * the boundary wrong.
 *
 * Falls back to the plain listing if `--verbose` yields nothing, so an older
 * host still gets a model list — just without the variant map.
 */
function probeHostModels(): { ids: string[]; variants: Record<string, string[]> } {
  const verbose = runOpencodeModels(["models", "--verbose"])
  if (verbose !== undefined) {
    const parsed = parseHostModels(verbose)
    if (parsed.ids.length > 0) return parsed
  }
  const plain = runOpencodeModels(["models"])
  if (plain === undefined) return { ids: [], variants: {} }
  return {
    ids: plain
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.includes("/")),
    variants: {},
  }
}

function runOpencodeModels(args: string[]): string | undefined {
  try {
    return execFileSync("opencode", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
      // `--verbose` prints ~60 lines of JSON per model, and a user connected
      // to a dozen providers can list thousands.
      maxBuffer: 128 * 1024 * 1024,
    })
  } catch {
    return undefined
  }
}

/**
 * Model records out of `opencode models --verbose`.
 *
 * Exported for its tests: this is the only place Observer reads the host's
 * resolved variant map, and getting it wrong would either silence models that
 * do take efforts or invent efforts for models that do not.
 *
 * The objects are pretty-printed with their braces alone in column zero, so a
 * lone `{` opens a record and a lone `}` closes it. Scanning for that is
 * steadier than trying to pair each object with the header line above it, and
 * a record that fails to parse is skipped rather than taking the run with it.
 */
export function parseHostModels(output: string): { ids: string[]; variants: Record<string, string[]> } {
  const ids: string[] = []
  const variants: Record<string, string[]> = {}
  let buffer: string[] | undefined

  for (const line of output.split("\n")) {
    if (buffer === undefined) {
      if (line === "{") buffer = ["{"]
      continue
    }
    buffer.push(line)
    if (line !== "}") continue
    const record = buffer.join("\n")
    buffer = undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(record)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const providerId = parsed["providerID"]
    const modelId = parsed["id"]
    if (typeof providerId !== "string" || typeof modelId !== "string") continue
    const id = `${providerId}/${modelId}`
    ids.push(id)
    // An absent `variants` key is not an empty one. Only a map the host
    // actually rendered may speak for the model; anything else leaves the
    // catalogue's own derivation in place.
    if (isRecord(parsed["variants"])) variants[id] = Object.keys(parsed["variants"])
  }
  return { ids, variants }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

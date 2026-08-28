import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import type { HostKind } from "../providers.js"
import type { SeatIssue, SeatTarget } from "../seats.js"
import type {
  CatalogueModel,
  HostCapabilities,
  HostProfile,
  HostSeatAdapter,
  ModelCatalogue,
  ModelOptionChoice,
  ModelOptionDescriptor,
} from "./types.js"

/**
 * The Codex host adapter: what models a Codex install offers, and what a seat
 * pointed at Codex is allowed to say.
 *
 * Observer ships no Codex model list, for the same reason it ships no OpenCode
 * one (see `models.ts`): a list baked into a release is stale the week after,
 * and Codex is the host most likely to move — its slugs are OpenAI's, its
 * reasoning efforts are an *open string set*, and its service tiers are a
 * second open set that has nothing to do with reasoning. The only source that
 * is right on the day the user opens the picker is the install in front of us.
 *
 * So the catalogue is a live probe of `codex app-server`:
 *
 *  1. spawn the binary, speaking JSON-RPC over stdio,
 *  2. `initialize`, then the `initialized` notification,
 *  3. `model/list`, following `nextCursor` until the pages run out.
 *
 * Three properties of that probe matter more than its results:
 *
 *  - **It never throws.** `catalogue()` returns an empty list with a warning
 *    for a missing binary, a hung server, a non-zero exit, a JSON-RPC error or
 *    a stdout full of banner noise. An empty catalogue is a supported state:
 *    the picker falls back to typing a slug, which is exactly what a user on a
 *    pre-release Codex needs anyway.
 *  - **It never runs at import.** Nothing in this module touches a process, a
 *    file or the network until `catalogue()` is called. Importing an adapter
 *    registry must not cost a subprocess per host.
 *  - **It never reads a credential.** The child's stderr is discarded rather
 *    than captured, `account/read` is not called, and no environment value is
 *    logged or returned. The probe wants an inventory, not an identity.
 *
 * ## Why a synchronous bridge, once per page
 *
 * `HostSeatAdapter.catalogue` is synchronous, while `codex app-server` is a
 * long-lived JSON-RPC server. Closing stdin immediately after `model/list`
 * disconnects the client before Codex's queued answer is ready. Each page is
 * therefore run behind a short-lived Node bridge: the adapter waits on the
 * bridge synchronously, while the bridge keeps Codex's stdin open until the
 * response arrives. It then closes the connection and exits. Page two still
 * carries the cursor learned from page one.
 *
 * That is one bridge and one app server per page. Codex lists on the order of
 * a dozen models, the result is memoised per profile, and the
 * alternative is either an async interface every caller would have to thread
 * through the TUI, or synchronous reads off a live child's pipe file
 * descriptors — which deadlocks the moment the child writes more than a pipe
 * buffer before we read. Two short-lived processes are cheap; a deadlocked
 * daemon is not.
 *
 * ## Efforts are the host's vocabulary, verbatim
 *
 * `SEAT_VARIANTS` is OpenCode's ladder. Codex's efforts are whatever the model
 * record says they are, and mapping an unrecognised one onto the nearest
 * familiar name would send the host a value the user never chose. Every effort
 * string this module emits is the string Codex printed, byte for byte, and the
 * same is true of service tiers — which travel in their own descriptor because
 * a tier is a billing lane, not a thinking budget, and collapsing the two
 * would put `flex` in a reasoning menu.
 */

/** The provider instance id the single default Codex install is seated under. */
export const CODEX_DEFAULT_PROFILE = "codex:default"

/**
 * Codex's own name for the reasoning knob, and the id a seat stores it under.
 *
 * Not `variant`. Option ids are the host's vocabulary by design — the value
 * has to go back to Codex untranslated — and borrowing OpenCode's name would
 * put a translation step between the picker and the host for no gain.
 */
export const CODEX_REASONING_OPTION = "reasoningEffort"

/**
 * The service-tier knob, kept strictly beside reasoning rather than inside it.
 *
 * A tier selects a billing and capacity lane; an effort selects how hard the
 * model thinks. They share a shape and nothing else.
 */
export const CODEX_SERVICE_TIER_OPTION = "serviceTier"

/** Command name assumed when no profile pins a `binaryPath`. */
const DEFAULT_BINARY = "codex"

/**
 * Whole-probe budget, spent across every page.
 *
 * Ten seconds gives a cold Codex app-server enough time to initialise before
 * it lists models. Four seconds proved too close to the real startup time on
 * Windows: the same install could answer on a warm run and time out on a cold
 * one, leaving the TUI with an empty picker.
 */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Floor on the per-page timeout, so the last page of a nearly-spent budget
 * still gets a fair chance rather than being killed on startup.
 */
const MIN_PAGE_TIMEOUT_MS = 750

/**
 * Hard stop on pagination.
 *
 * A server that returns the same cursor forever would otherwise spin until the
 * budget ran out, spawning a process per turn of the loop. The cap turns that
 * bug into a truncated list with a warning.
 */
const MAX_PAGES = 20

/**
 * How long a successful probe is trusted.
 *
 * Not forever: a user who upgrades Codex in place while the daemon runs should
 * see the new models without restarting anything. Ten minutes is long enough
 * that a picker session costs one probe and short enough that an upgrade is
 * noticed the same sitting.
 */
const SUCCESS_TTL_MS = 10 * 60_000

/**
 * How long a *failed* probe is remembered.
 *
 * Failures are cached deliberately. Without this, a machine with no `codex` on
 * `PATH` pays a process spawn for every repaint of a picker that will never
 * have anything to show. Thirty seconds is short enough that installing Codex
 * and coming back works without a restart.
 */
const FAILURE_TTL_MS = 30_000

/** JSON-RPC ids. Fixed, because each process handles exactly one of each. */
const INITIALIZE_ID = 1
const MODEL_LIST_ID = 2

/**
 * The one call this module makes into the operating system.
 *
 * A deliberately narrow seam rather than `spawnSync`'s own signature: tests
 * fake a Codex host by returning three fields, and — more importantly — the
 * seam has no channel for stderr at all, so there is no route by which a
 * credential printed on the child's error stream could reach a log, a warning
 * or a test fixture.
 */
export type CodexSpawn = (
  binary: string,
  args: readonly string[],
  options: { input: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => CodexSpawnResult

export interface CodexSpawnResult {
  /** Whatever the child wrote to stdout before it exited or was killed. */
  stdout: string
  /** Exit code, or null when the child was signalled. */
  status: number | null
  /** True when the budget expired and the child was killed. */
  timedOut?: boolean
  /**
   * Why the child never ran, in words safe to show a user — a missing binary,
   * a permission error. Absent when the process started, whatever it then did.
   */
  failure?: string
}

export interface CodexAdapterOptions {
  /** Environment to resolve `CODEX_HOME` from. Defaults to the real one. */
  env?: NodeJS.ProcessEnv
  /** Home directory resolver, so tests need no real `$HOME`. */
  homeDir?: () => string
  /** Executable to launch when the profile does not pin one. */
  binaryPath?: string
  /** Whole-probe budget in milliseconds. */
  timeoutMs?: number
  /** Clock, injected so cache expiry is testable without waiting. */
  now?: () => number
  /** Process launcher. Injected by tests; never a real Codex in a test run. */
  spawn?: CodexSpawn
}

interface CacheEntry {
  at: number
  ttl: number
  catalogue: ModelCatalogue
}

/**
 * Builds a Codex adapter over injected surroundings.
 *
 * The default export is one of these over the real environment. The factory
 * exists because everything interesting about this adapter is a failure mode
 * of a subprocess, and a test that has to install Codex to exercise a timeout
 * is a test nobody runs.
 */
export function createCodexAdapter(options: CodexAdapterOptions = {}): HostSeatAdapter {
  const env = options.env ?? process.env
  const readHome = options.homeDir ?? homedir
  const binary = options.binaryPath && options.binaryPath.length > 0 ? options.binaryPath : DEFAULT_BINARY
  const budgetMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now
  const spawn = options.spawn ?? spawnCodexAppServer
  const cache = new Map<string, CacheEntry>()

  /**
   * Where this install keeps its config and auth.
   *
   * `CODEX_HOME` first because that is the switch Codex itself honours, and
   * the one a user running a second account has already set. `~/.codex` is the
   * default every install has.
   */
  function resolveHome(): string {
    const configured = env["CODEX_HOME"]
    if (typeof configured === "string" && configured.trim().length > 0) return configured.trim()
    return join(readHome(), ".codex")
  }

  function resolveProfile(): HostProfile {
    const home = resolveHome()
    return {
      id: CODEX_DEFAULT_PROFILE,
      host: "codex" as HostKind,
      // The home is in the label only when it is not the default one, so the
      // common case reads "Codex" and the two-account case is still
      // distinguishable at a glance.
      label: home === join(readHome(), ".codex") ? "Codex" : `Codex (${home})`,
      binaryPath: binary,
      homePath: home,
    }
  }

  function probe(profile: HostProfile): ModelCatalogue {
    const home = profile.homePath ?? resolveHome()
    const source = `${binary} app-server model/list (CODEX_HOME=${home})`
    const warnings: string[] = []
    const records: CatalogueModel[] = []
    const seen = new Set<string>()
    const deadline = now() + budgetMs

    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const remaining = deadline - now()
      if (remaining <= 0) {
        warnings.push(`Codex did not finish listing models within ${budgetMs} ms, so this list may be incomplete.`)
        break
      }

      const result = requestPage({
        spawn,
        binary,
        home,
        env,
        cursor,
        timeoutMs: Math.max(remaining, MIN_PAGE_TIMEOUT_MS),
      })

      if (result.kind === "failure") {
        warnings.push(describeFailure(result, binary, budgetMs, page))
        break
      }

      for (const raw of result.models) {
        const model = readModel(raw)
        // Duplicate ids across pages are a server bug, not a user problem;
        // dropping the repeat keeps the picker from showing a model twice.
        if (!model || seen.has(model.id)) continue
        seen.add(model.id)
        records.push(model)
      }

      if (result.nextCursor === undefined) return finish(records, source, warnings)
      // A cursor identical to the one we just sent is the loop `MAX_PAGES`
      // guards, caught one page earlier and without the extra process.
      if (result.nextCursor === cursor) {
        warnings.push("Codex repeated the same model/list cursor, so this list may be incomplete.")
        break
      }
      cursor = result.nextCursor
    }

    if (records.length === 0) {
      // Nothing usable came back. `unknown` rather than `live`: we did not
      // learn that Codex has no models, we failed to learn anything, and the
      // difference is what stops the picker claiming an empty inventory.
      return { models: [], source, freshness: "unknown", warnings }
    }
    return finish(records, source, warnings)
  }

  /**
   * A partial page-set is still worth returning.
   *
   * The warning already says the list may be incomplete, and eleven models a
   * user can pick from beats zero plus the same sentence. `live` is honest
   * here — every record in it did come from this host, this second.
   */
  function finish(models: CatalogueModel[], source: string, warnings: string[]): ModelCatalogue {
    return { models, source, freshness: "live", warnings }
  }

  function catalogue(profileId: string): ModelCatalogue {
    // Wrapped whole: the contract is that this function returns a catalogue,
    // and a defect anywhere below — a parser that trips on a shape nobody
    // anticipated, a launcher that throws where it promised a result — must
    // degrade to "no models, here is why" rather than take down the caller.
    try {
      const profile = resolveProfile()
      if (profileId !== profile.id) {
        return {
          models: [],
          source: `${binary} app-server model/list`,
          freshness: "unknown",
          warnings: [`Observer has no Codex profile called "${profileId}", so there is nothing to list models from.`],
        }
      }

      const key = cacheKey(profile)
      const cached = cache.get(key)
      if (cached && now() - cached.at < cached.ttl) {
        // Memoised, so say memoised. A caller that renders "live" over a
        // ten-minute-old answer is overstating what it knows, and this is the
        // same house rule `ModelVariants` exists to enforce next door.
        return { ...cached.catalogue, freshness: "cached", warnings: [...cached.catalogue.warnings] }
      }

      const fresh = probe(profile)
      cache.set(key, {
        at: now(),
        // A failure is remembered for far less time than a success: it is much
        // more likely to be fixed in the next thirty seconds than a model list
        // is to change.
        ttl: fresh.models.length > 0 ? SUCCESS_TTL_MS : FAILURE_TTL_MS,
        catalogue: fresh,
      })
      return fresh
    } catch (error) {
      return {
        models: [],
        source: `${binary} app-server model/list`,
        freshness: "unknown",
        warnings: [`Observer could not read the Codex model list: ${describeError(error)}.`],
      }
    }
  }

  /**
   * What is wrong with one Codex target, and nothing that merely differs.
   *
   * Two rules, and deliberately no third:
   *
   *  - A Codex model is a **bare slug**. `gpt-5.6-sol` is correct as written,
   *    and the `provider/model` rule `diagnoseOpencodeModel` applies is
   *    OpenCode's addressing scheme, not a fact about models. Applying it here
   *    would fail `SeatDiagnosis.ok` on a perfectly good config. The only
   *    model this rejects is one that is present and empty, which is a field
   *    the user started filling in and left.
   *  - An effort the selected model does not advertise is a **warning**, never
   *    an error, worded the way `diagnoseSeats` words an unrecognised variant:
   *    subsets differ, and the host has the final say.
   *
   * The effort check reads the memoised catalogue and never probes. Diagnosis
   * runs on half-typed input in a TUI, and a config keystroke must not cost a
   * subprocess. With no cached inventory there is no warning at all — silence
   * beats inventing an authority we do not have.
   */
  function diagnose(profileId: string, targetId: string, target: SeatTarget, employeeId: string): SeatIssue[] {
    try {
      const issues: SeatIssue[] = []
      const basePath = `seats.employees.${employeeId}.targets.${targetId}`
      const add = (
        code: SeatIssue["code"],
        severity: SeatIssue["severity"],
        suffix: string,
        message: string,
      ): void => {
        issues.push({
          code,
          severity,
          path: suffix ? `${basePath}.${suffix}` : basePath,
          employeeId,
          targetId,
          host: "codex",
          message,
        })
      }

      const rawModel = typeof target?.model === "string" ? target.model : undefined
      const model = rawModel?.trim()

      if (rawModel !== undefined && (model === undefined || model.length === 0)) {
        add(
          "malformed-model",
          "error",
          "model",
          'This Codex target sets an empty model. Codex models are bare slugs, for example "gpt-5.6-sol" — write one, or remove the field.',
        )
        return issues
      }

      if (model === undefined || model.length === 0) return issues

      const effort = readOption(target, CODEX_REASONING_OPTION)
      if (effort === undefined) return issues

      // Only a cached probe may speak for a model. An id the probe never
      // mentioned is not evidence the id is wrong — Codex ships models faster
      // than Observer ships releases — so an unlisted model warns about
      // nothing at all.
      const known = cachedModel(profileId, model)
      if (!known) return issues
      const advertised = known.options.find((option) => option.id === CODEX_REASONING_OPTION)?.choices ?? []
      if (advertised.length === 0) return issues
      if (advertised.some((choice) => choice.id === effort)) return issues

      add(
        "unrecognised-variant",
        "warning",
        "options",
        `"${effort}" is not a reasoning effort ${model} advertises (${advertised.map((choice) => choice.id).join(", ")}). Models accept different subsets, so this may still work — the host has the final say.`,
      )
      return issues
    } catch {
      // Same contract as `catalogue`: a diagnosis that throws is worse than no
      // diagnosis, because the caller is a config screen holding half a line
      // of someone's typing.
      return []
    }
  }

  /** The memoised record for a slug, or undefined when nothing is cached. */
  function cachedModel(profileId: string, modelId: string): CatalogueModel | undefined {
    const profile = resolveProfile()
    if (profileId !== profile.id) return undefined
    const entry = cache.get(cacheKey(profile))
    // An expired entry is treated as no entry. Warning about an effort against
    // a model list from two hours and one Codex upgrade ago is exactly the
    // kind of confident wrongness this module is built to avoid.
    if (!entry || now() - entry.at >= entry.ttl) return undefined
    return entry.catalogue.models.find((model) => model.id === modelId)
  }

  /**
   * Cache identity: profile, binary and home.
   *
   * All three, because they are what decides the answer. Two profiles pointing
   * at different homes are different accounts with different model access, and
   * a profile repointed at a vendored binary is a different Codex build. Any
   * of them changing must miss the cache rather than serve the other one's
   * inventory.
   */
  function cacheKey(profile: HostProfile): string {
    return `${profile.id}\u0000${binary}\u0000${profile.homePath ?? ""}`
  }

  return {
    kind: "codex" as HostKind,
    label: "Codex",
    profiles(): HostProfile[] {
      // One profile per home, and one home per environment: Codex routes an
      // account by `CODEX_HOME`, so two accounts are two homes and there is
      // nothing else here to enumerate. A second configured profile arrives as
      // a `providers` entry with its own `homePath`, not as a discovery.
      try {
        return [resolveProfile()]
      } catch {
        return []
      }
    },
    catalogue,
    diagnose,
    capabilities(): HostCapabilities {
      return {
        // The inventory is a live probe of the install in front of us.
        discovery: "live",
        // Observer generates native Codex custom-agent TOML for every employee.
        // A controlled seat adds model and reasoning fields to that employee's
        // definition; an unpinned employee inherits Codex's choice.
        childModel: "supported",
        childReasoning: "supported",
        // Codex discovers custom agents at startup.
        requiresReload: true,
      }
    },
  }
}

/** The adapter over the real environment. Constructing it spawns nothing. */
export const codexAdapter: HostSeatAdapter = createCodexAdapter()

interface PageSuccess {
  kind: "page"
  models: unknown[]
  nextCursor?: string
}

interface PageFailure {
  kind: "failure"
  reason: "unstarted" | "timeout" | "exit" | "protocol" | "rpc-error"
  detail?: string
  status?: number | null
}

/**
 * One handshake, one `model/list`, one process.
 *
 * The three messages go out in a single write and stdin is then closed, which
 * is what tells a stdio JSON-RPC server it has no more work and lets it exit
 * on its own. The timeout is the backstop for a server that does not take the
 * hint, not the normal path.
 *
 * stdout is parsed *before* the exit status is judged, on purpose. A server
 * that answered correctly and then declined to exit was killed by the budget,
 * and the answer it already gave us is still a good answer; failing the page
 * on the corpse's exit code would throw away a complete model list over a
 * shutdown bug.
 */
function requestPage(args: {
  spawn: CodexSpawn
  binary: string
  home: string
  env: NodeJS.ProcessEnv
  cursor: string | undefined
  timeoutMs: number
}): PageSuccess | PageFailure {
  const params = args.cursor === undefined ? {} : { cursor: args.cursor }
  const input = [
    // `clientInfo` is the only thing the handshake needs to carry, and it says
    // who is asking. Nothing about the user, the workspace or the account.
    JSON.stringify({
      jsonrpc: "2.0",
      id: INITIALIZE_ID,
      method: "initialize",
      params: { clientInfo: { name: "observer", title: "Observer", version: "0.9.16" } },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: MODEL_LIST_ID, method: "model/list", params }),
    "",
  ].join("\n")

  let result: CodexSpawnResult
  try {
    result = args.spawn(args.binary, ["app-server"], {
      input,
      // The child inherits the environment because it needs a `PATH`, a
      // `HOME` and whatever a version manager put there to be launchable at
      // all. `CODEX_HOME` is pinned so the probe reads the profile we mean
      // rather than whichever one the daemon happened to be started under.
      env: { ...args.env, CODEX_HOME: args.home },
      timeoutMs: args.timeoutMs,
    })
  } catch (error) {
    // A launcher that throws instead of reporting is still just a host that
    // did not answer.
    return { kind: "failure", reason: "unstarted", detail: describeError(error) }
  }

  if (result.failure !== undefined) return { kind: "failure", reason: "unstarted", detail: result.failure }

  const response = findResponse(result.stdout)
  if (response === undefined) {
    if (result.timedOut === true) return { kind: "failure", reason: "timeout" }
    if (result.status !== 0) return { kind: "failure", reason: "exit", status: result.status }
    return { kind: "failure", reason: "protocol" }
  }

  if (isRecord(response["error"])) {
    // The server's own words, and only its `message`: a JSON-RPC error object
    // may carry a `data` payload, and this module has no business rendering
    // something it has not inspected.
    const message = response["error"]["message"]
    const failure: PageFailure = { kind: "failure", reason: "rpc-error" }
    if (typeof message === "string" && message.length > 0) failure.detail = message
    return failure
  }

  const payload = response["result"]
  if (!isRecord(payload)) return { kind: "failure", reason: "protocol" }

  const page: PageSuccess = { kind: "page", models: readItems(payload) }
  const cursor = readCursor(payload)
  if (cursor !== undefined) page.nextCursor = cursor
  return page
}

/**
 * The `model/list` response, out of a stream that is not only responses.
 *
 * Every line is tried and every failure is skipped, because stdout from a CLI
 * is not a clean JSON-RPC channel: an update banner, a deprecation notice or a
 * progress notification all land on it, and one unparseable line must not cost
 * the page. Matching on the request id — rather than taking the last object —
 * is what stops a server-initiated notification arriving mid-flight from being
 * mistaken for the answer.
 */
function findResponse(stdout: string): Record<string, unknown> | undefined {
  if (typeof stdout !== "string" || stdout.length === 0) return undefined
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || !trimmed.startsWith("{")) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    if (parsed["id"] !== MODEL_LIST_ID) continue
    return parsed
  }
  return undefined
}

/**
 * The model array, whichever of its three plausible names it arrived under.
 *
 * Observer has no checked fixture of this envelope — the research read it out
 * of a third-party driver, not a schema we can pin — so the reader accepts
 * `items`, `models` and `data` rather than betting the whole feature on one
 * key. Guessing wrong costs an empty picker on a host that answered fine.
 */
function readItems(payload: Record<string, unknown>): unknown[] {
  for (const key of ["items", "models", "data"]) {
    const value = payload[key]
    if (Array.isArray(value)) return value
  }
  return []
}

/** Same tolerance, for the cursor. An empty cursor means "no more pages". */
function readCursor(payload: Record<string, unknown>): string | undefined {
  for (const key of ["nextCursor", "next_cursor", "cursor"]) {
    const value = payload[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/**
 * One Codex model record, or undefined when it carries no usable id.
 *
 * The id is the only required field: a record Observer cannot name is a record
 * a seat cannot store, and offering it would put a blank row in the picker.
 * Everything else degrades — an unnamed model is labelled by its slug, a model
 * with no advertised efforts simply gets no effort control.
 */
export function readModel(raw: unknown): CatalogueModel | undefined {
  if (!isRecord(raw)) return undefined
  const id = firstString(raw, ["id", "slug", "model", "name"])
  if (id === undefined) return undefined

  const model: CatalogueModel = {
    id,
    label: firstString(raw, ["displayName", "display_name", "label", "name"]) ?? id,
    options: [],
  }

  const context = firstNumber(raw, ["contextWindow", "context_window", "contextLength", "context_length"])
  if (context !== undefined && context > 0) model.contextWindow = context

  const effort = descriptor({
    id: CODEX_REASONING_OPTION,
    label: "Reasoning effort",
    choices: readChoices(raw, ["supportedReasoningEfforts", "supported_reasoning_efforts", "reasoningEfforts"]),
    declaredDefault: firstString(raw, ["defaultReasoningEffort", "default_reasoning_effort", "reasoningEffort"]),
  })
  if (effort) model.options.push(effort)

  // A second descriptor, never merged into the first. A service tier selects a
  // billing and capacity lane; a reasoning effort selects how hard the model
  // thinks. They share a shape and nothing else, and a user who found `flex`
  // in a reasoning menu would rightly not trust the menu.
  const tier = descriptor({
    id: CODEX_SERVICE_TIER_OPTION,
    label: "Service tier",
    choices: readChoices(raw, ["supportedServiceTiers", "supported_service_tiers", "serviceTiers"]),
    declaredDefault: firstString(raw, ["defaultServiceTier", "default_service_tier", "serviceTier"]),
  })
  if (tier) model.options.push(tier)

  return model
}

/**
 * A select control, or undefined when there is nothing to select between.
 *
 * An empty descriptor is worse than an absent one: it renders as a control the
 * user can open and cannot use. A model that advertises no efforts gets no
 * effort control at all, and the picker says nothing rather than something
 * false.
 */
function descriptor(args: {
  id: string
  label: string
  choices: ModelOptionChoice[]
  declaredDefault: string | undefined
}): ModelOptionDescriptor | undefined {
  const choices = [...args.choices]
  const declared = args.declaredDefault

  // A default the list does not contain is still a value the host accepts —
  // it just told us it uses it. Dropping it would leave the picker unable to
  // reproduce the host's own behaviour.
  if (declared !== undefined && !choices.some((choice) => choice.id === declared)) {
    choices.push({ id: declared, label: declared, isDefault: true })
  }

  if (choices.length === 0) return undefined

  const marked = choices.map((choice) => {
    if (declared === undefined) return choice
    const isDefault = choice.id === declared
    return isDefault ? { ...choice, isDefault: true } : stripDefault(choice)
  })

  const result: ModelOptionDescriptor = { id: args.id, label: args.label, type: "select", choices: marked }
  const current = declared ?? marked.find((choice) => choice.isDefault === true)?.id
  if (current !== undefined) result.currentValue = current
  return result
}

function stripDefault(choice: ModelOptionChoice): ModelOptionChoice {
  if (choice.isDefault === undefined) return choice
  const { isDefault: _dropped, ...rest } = choice
  return rest
}

/**
 * The choices for one open-string option, verbatim.
 *
 * Codex writes these two ways — a plain array of strings, or an array of
 * objects with a label and a default flag — and both are read. What is *not*
 * done here is any normalisation of the value: no lower-casing, no mapping
 * onto `SEAT_VARIANTS`, no dropping of a level Observer has not seen before.
 * The string that goes into `choice.id` is the string that came out of Codex,
 * because it is the string that has to go back in for the model to accept it.
 * A label is prettified only when Codex supplied a prettier one itself.
 */
export function readChoices(raw: Record<string, unknown>, keys: readonly string[]): ModelOptionChoice[] {
  const choices: ModelOptionChoice[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    const value = raw[key]
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      const choice = readChoice(entry)
      if (!choice || seen.has(choice.id)) continue
      seen.add(choice.id)
      choices.push(choice)
    }
    // First key that carries an array wins outright. Merging two spellings of
    // the same list would double every entry on a host that sends both.
    if (choices.length > 0) break
  }
  return choices
}

function readChoice(entry: unknown): ModelOptionChoice | undefined {
  if (typeof entry === "string") {
    const id = entry.trim()
    return id.length === 0 ? undefined : { id, label: id }
  }
  if (!isRecord(entry)) return undefined
  const id = firstString(entry, ["id", "value", "reasoningEffort", "serviceTier", "effort", "tier", "name"])
  if (id === undefined) return undefined
  const choice: ModelOptionChoice = { id, label: firstString(entry, ["label", "displayName", "display_name"]) ?? id }
  if (entry["isDefault"] === true || entry["default"] === true) choice.isDefault = true
  return choice
}

/**
 * One sentence a user can act on, for each way the probe can fail.
 *
 * Every branch names the binary or the budget, because the two questions a
 * user has are "is it installed" and "is it hanging", and a warning that says
 * neither sends them to a log file. `page` is in the wording because a failure
 * on page three means something different from a failure on page one: the
 * first is a partial list, the second is no list.
 */
function describeFailure(failure: PageFailure, binary: string, budgetMs: number, page: number): string {
  const scope = page === 0 ? "so no Codex models are listed" : "so this list may be incomplete"
  switch (failure.reason) {
    case "unstarted":
      return `Codex could not be started: "${binary}" ${failure.detail ?? "did not run"}. Install Codex or set this profile's binary path, ${scope}.`
    case "timeout":
      return `Codex did not answer "model/list" within ${budgetMs} ms, ${scope}.`
    case "exit":
      return `"${binary} app-server" exited${failure.status === null || failure.status === undefined ? "" : ` with code ${failure.status}`} before listing models, ${scope}.`
    case "rpc-error":
      return `Codex refused "model/list"${failure.detail === undefined ? "" : `: ${failure.detail}`}, ${scope}.`
    default:
      return `Codex returned no readable answer to "model/list", ${scope}. This usually means the installed Codex is older than its app-server protocol.`
  }
}

/**
 * Runs one app-server exchange behind a short-lived asynchronous bridge.
 *
 * `spawnSync` cannot keep a child's stdin open after writing its input. Codex
 * queues `model/list` and answers while the JSON-RPC connection remains live,
 * so closing the pipe with the write drops the answer. The bridge holds that
 * pipe open, forwards stdout, and closes it after response id 2 arrives.
 *
 * The bridge also launches Windows npm shims through `cmd.exe`. Node cannot
 * execute a `.cmd` shim directly with `spawnSync`; on a normal npm install the
 * old path failed with EPERM before Codex started.
 */
export function spawnCodexAppServer(
  binary: string,
  args: readonly string[],
  options: { input: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): CodexSpawnResult {
  const specification = Buffer.from(
    JSON.stringify({
      binary,
      args,
      platform: process.platform,
      comspec: process.env["ComSpec"] ?? process.env["COMSPEC"] ?? "cmd.exe",
      timeoutMs: options.timeoutMs,
    }),
  ).toString("base64")
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", CODEX_APP_SERVER_BRIDGE, specification],
    {
      input: options.input,
      env: options.env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      // The bridge owns the advertised budget. This catches a bridge defect.
      timeout: options.timeoutMs + 1_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  )

  const spawnResult: CodexSpawnResult = {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    status: result.status,
  }
  const bridgeFailure = readBridgeFailure(spawnResult.stdout)
  if (bridgeFailure?.kind === "timeout") spawnResult.timedOut = true
  else if (bridgeFailure?.kind === "spawn") spawnResult.failure = describeSpawnCode(bridgeFailure.code)
  const error = result.error as (Error & { code?: string }) | undefined
  if (error?.code === "ETIMEDOUT") spawnResult.timedOut = true
  else if (error !== undefined) spawnResult.failure = describeSpawnError(error)
  // Killed without an error object — a `timeout` on some platforms reports
  // only the signal — is still a timeout.
  else if (result.signal !== null && result.signal !== undefined) spawnResult.timedOut = true
  return spawnResult
}

interface BridgeFailure {
  kind: "spawn" | "timeout"
  code?: string
}

function readBridgeFailure(stdout: string): BridgeFailure | undefined {
  for (const line of stdout.split("\n")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed) || !isRecord(parsed["observerCodexProbe"])) continue
    const marker = parsed["observerCodexProbe"]
    if (marker["kind"] !== "spawn" && marker["kind"] !== "timeout") continue
    const failure: BridgeFailure = { kind: marker["kind"] }
    if (typeof marker["code"] === "string") failure.code = marker["code"]
    return failure
  }
  return undefined
}

function describeSpawnCode(code: string | undefined): string {
  if (code === "ENOENT") return "was not found on PATH"
  if (code === "EACCES") return "is not executable"
  return `could not be launched (${code ?? "unknown error"})`
}

/** Static source avoids a runtime asset that TypeScript would have to copy. */
const CODEX_APP_SERVER_BRIDGE = String.raw`
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

const specification = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"))
const input = readFileSync(0, "utf8")
let command = specification.binary
let args = specification.args
let windowsVerbatimArguments = false

if (specification.platform === "win32") {
  const values = [command, ...args]
  if (values.some((value) => /[\r\n"%!&|<>^]/.test(value))) {
    process.stdout.write(JSON.stringify({ observerCodexProbe: { kind: "spawn", code: "UNSAFE_WINDOWS_COMMAND" } }) + "\n")
    process.exit(127)
  }
  const commandLine = values.map((value) => '"' + value + '"').join(" ")
  command = specification.comspec
  args = ["/d", "/s", "/c", '"' + commandLine + '"']
  windowsVerbatimArguments = true
}

const child = spawn(command, args, {
  env: process.env,
  stdio: ["pipe", "pipe", "ignore"],
  windowsHide: true,
  windowsVerbatimArguments,
})
let responseSeen = false
let settled = false
let buffer = ""
let shutdownTimer

const timer = setTimeout(() => {
  if (settled) return
  settled = true
  child.kill()
  process.stdout.write(JSON.stringify({ observerCodexProbe: { kind: "timeout" } }) + "\n", () => process.exit(124))
}, specification.timeoutMs)

child.on("error", (error) => {
  if (settled) return
  settled = true
  clearTimeout(timer)
  process.stdout.write(
    JSON.stringify({ observerCodexProbe: { kind: "spawn", code: error && error.code } }) + "\n",
    () => process.exit(127),
  )
})

child.stdin.on("error", () => {})
child.stdout.setEncoding("utf8")
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk)
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf("\n")
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message && message.id === 2) {
      responseSeen = true
      clearTimeout(timer)
      child.stdin.end()
      shutdownTimer = setTimeout(() => child.kill(), 250)
    }
  }
})

child.on("close", (code) => {
  if (settled) return
  settled = true
  clearTimeout(timer)
  clearTimeout(shutdownTimer)
  process.exit(responseSeen ? 0 : (code ?? 1))
})

child.stdin.write(input)
`

function describeSpawnError(error: Error & { code?: string }): string {
  if (error.code === "ENOENT") return "was not found on PATH"
  if (error.code === "EACCES") return "is not executable"
  return `could not be launched (${error.code ?? error.message})`
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "unknown error"
}

/** The value a target set for one option id, when it is a non-empty string. */
function readOption(target: SeatTarget, id: string): string | undefined {
  const options = Array.isArray(target?.options) ? target.options : []
  for (const option of options) {
    if (!isRecord(option) || option["id"] !== id) continue
    const value = option["value"]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function firstString(raw: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === "string" && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function firstNumber(raw: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

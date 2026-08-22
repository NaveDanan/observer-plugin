import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import type { HostKind } from "../providers.js"
import type { SeatIssue, SeatIssueSeverity, SeatTarget } from "../seats.js"
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
 * The GitHub Copilot CLI host adapter: what a Copilot install can run, and what
 * a seat pointed at Copilot is allowed to claim.
 *
 * This adapter sits one directory away from a GitHub credential store, so the
 * threat model came before the feature. `$COPILOT_HOME` (default `~/.copilot`)
 * holds the CLI's stored GitHub token alongside its config, and
 * `copilot help environment` names `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and
 * `GITHUB_TOKEN` as live credential inputs. Observer's business with that
 * directory begins and ends at *naming* it so the CLI can find its own: nothing
 * below stats it, lists it, opens it or writes to it, and the one env value
 * this module ever sets on a child is a path plus two switches that make the
 * child quieter.
 *
 * ## Where the answers came from
 *
 * There was no prior research base for Copilot — the multi-provider studies in
 * `docs/research/multi-provider/` cover t3code's providers, and t3code does not
 * drive Copilot CLI. Everything asserted here was read off the installed
 * binary, GitHub Copilot CLI 1.0.80, on 2026-08-23:
 *
 *  - `copilot --help` declares `--model <model>` ("use 'auto' to let Copilot
 *    pick automatically"), `--effort, --reasoning-effort <level>` with the
 *    closed choice set `none, minimal, low, medium, high, xhigh, max`, and
 *    `--context <tier>` with `default, long_context`.
 *  - `copilot help config` documents the `model` setting and prints its
 *    accepted values as a bullet list — the model inventory this adapter reads.
 *  - `copilot help config` also documents
 *    `subagents.agents.<agent-name>`: "per-subagent model, effortLevel, and
 *    contextTier selection", each field settable to `"inherit"`.
 *  - `copilot help environment` documents `COPILOT_HOME`, `COPILOT_MODEL` and
 *    `COPILOT_AUTO_UPDATE`.
 *
 * Corroborated against the official docs at
 * https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli
 * (accessed 2026-08-23) for the config directory, the `COPILOT_HOME` override
 * and the fact that delegation to a subagent is a decision the *model* makes,
 * not a call the caller places.
 *
 * ## Why the probe is a help text read, and not anything richer
 *
 * Copilot has an ACP server (`copilot --acp`) and a JSON output mode, which is
 * the kind of surface the Codex adapter talks JSON-RPC to. Both of those start
 * a *session*: they resolve an account, they can prompt for login, and they can
 * bill. An inventory probe fires on a keystroke in a config screen, and a
 * keystroke must never be able to authenticate, spend or mutate session state.
 *
 * So both probes are argv-only help topics with stdin closed. They were checked
 * against a fresh empty `COPILOT_HOME` on 1.0.80: neither created a file, and
 * `copilot help config` returns byte-identical output with `COPILOT_OFFLINE=true`
 * set, which is as close to proof as is available that it reads no network and
 * needs no credential. The list is a property of the installed build, which is
 * exactly the thing the user is about to point a seat at.
 *
 * Three properties of the probe matter more than its results, and they are the
 * same three the Codex adapter is built around:
 *
 *  - **It never throws.** `catalogue()` and `diagnose()` return a value for a
 *    missing binary, a hung CLI, a non-zero exit, or help output whose shape
 *    changed under us. An empty catalogue is a supported state: the picker
 *    falls back to typing a slug by hand, and `capabilities().discovery`
 *    degrades to `"manual"` so the UI says so out loud.
 *  - **It never runs at import.** Nothing here touches a process, a file or the
 *    network until `catalogue()` is called.
 *  - **It never reads a credential.** stderr is discarded rather than captured,
 *    stdin is closed, no subcommand that authenticates is ever invoked, and no
 *    environment value is logged or returned.
 *
 * ## `COPILOT_AUTO_UPDATE=false` is a security control, not a convenience
 *
 * Copilot CLI auto-updates itself by default (`copilot help environment`), and
 * 1.0.80 prints "Run 'copilot update' to check for updates" on `--version`. An
 * inventory probe that can trigger a background download of a new build of the
 * user's toolchain is Observer reaching into a supply chain it was not invited
 * into — on a keystroke, unattended, with no record. The probe env pins the
 * documented off switch so a config screen can never cause an upgrade.
 */

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** The provider instance id the single default Copilot install is seated under. */
export const COPILOT_DEFAULT_PROFILE = "copilot:default"

/**
 * Copilot's own name for the reasoning knob, and the id a seat stores it under.
 *
 * `effortLevel`, not `effort` and not `reasoningEffort`. The CLI *flag* is
 * `--effort`, but the field name in Copilot's own configuration vocabulary is
 * `effortLevel` — that is the spelling `copilot help config` uses for
 * `subagents.agents.<agent-name>`, and the config is the surface any future
 * control path has to write. Option ids are the host's vocabulary by design, so
 * a value round-trips through Observer's config untranslated.
 */
export const COPILOT_REASONING_OPTION = "effortLevel"

/**
 * The context-window tier knob, kept strictly beside reasoning.
 *
 * A tier selects how much context is bought (and, per Copilot's own wording,
 * how it is priced); an effort selects how hard the model thinks. They share a
 * shape and nothing else, and merging them would put `long_context` in a
 * reasoning menu.
 *
 * Note that this id is *recognised* but no descriptor is ever emitted for it —
 * see `descriptorsFor` for why.
 */
export const COPILOT_CONTEXT_TIER_OPTION = "contextTier"

/** The two option ids this adapter understands. Nothing else is a Copilot option. */
export const COPILOT_OPTION_IDS = [COPILOT_REASONING_OPTION, COPILOT_CONTEXT_TIER_OPTION] as const

/** Command name assumed when no profile pins a `binaryPath`. */
const DEFAULT_BINARY = "copilot"

/**
 * The model id that means "let Copilot choose".
 *
 * Documented by `copilot --help` on the `--model` option and absent from the
 * `copilot help config` bullet list, so it is added to the catalogue only when
 * the `--help` probe actually said so. Inventing it would be the small,
 * plausible lie this module exists to avoid.
 */
const AUTO_MODEL = "auto"

/**
 * Whole-probe budget, spent across both help topics.
 *
 * Six seconds because this sits behind a TUI keystroke, not a build step, and
 * because Copilot's help topics are not instant: `copilot help config` measured
 * ~1.4 s cold on 1.0.80, and there are two of them. A user with no Copilot
 * installed must not watch the picker hang; anything past this is a host that
 * is not going to answer at all.
 */
const DEFAULT_TIMEOUT_MS = 6_000

/**
 * Floor on the per-probe timeout, so the second topic still gets a fair chance
 * rather than being killed on startup by a nearly-spent budget.
 */
const MIN_PROBE_TIMEOUT_MS = 1_500

/**
 * How long a successful probe is trusted.
 *
 * Not forever: a user who runs `copilot update` while the daemon is running
 * should see the new model list without restarting anything. Ten minutes is
 * long enough that a picker session costs one probe and short enough that an
 * upgrade is noticed the same sitting. Same figure, same reasoning, as the
 * Codex adapter.
 */
const SUCCESS_TTL_MS = 10 * 60_000

/**
 * How long a *failed* probe is remembered.
 *
 * Failures are cached deliberately. Without this, a machine with no `copilot`
 * on `PATH` pays a process spawn for every repaint of a picker that will never
 * have anything to show. Thirty seconds is short enough that installing Copilot
 * and coming back works without a restart.
 */
const FAILURE_TTL_MS = 30_000

/* -------------------------------------------------------------------------- */
/* The spawn seam                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The one call this module makes into the operating system.
 *
 * A deliberately narrow seam rather than `spawnSync`'s own signature, and
 * narrower than the Codex one in the way that matters here: there is **no
 * `input` field**, because neither probe takes stdin, and a seam with no way to
 * write to the child is a seam that cannot be made to send a prompt, a token or
 * a slash command by a later edit. There is likewise no channel for stderr, so
 * there is no route by which a credential printed on the child's error stream
 * could reach a log, a warning or a test fixture.
 */
export type CopilotSpawn = (
  binary: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => CopilotSpawnResult

export interface CopilotSpawnResult {
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

export interface CopilotAdapterOptions {
  /** Environment to resolve `COPILOT_HOME` from. Defaults to the real one. */
  env?: NodeJS.ProcessEnv
  /** Home directory resolver, so tests need no real `$HOME`. */
  homeDir?: () => string
  /** Executable to launch when the profile does not pin one. */
  binaryPath?: string
  /** Whole-probe budget in milliseconds. */
  timeoutMs?: number
  /** Clock, injected so cache expiry is testable without waiting. */
  now?: () => number
  /** Process launcher. Injected by tests; never a real Copilot in a test run. */
  spawn?: CopilotSpawn
}

interface CacheEntry {
  at: number
  ttl: number
  catalogue: ModelCatalogue
}

/* -------------------------------------------------------------------------- */
/* Help-text parsing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The model ids `copilot help config` prints under its `model` setting.
 *
 * The section looks like this, and the parse is anchored on the shape rather
 * than on any particular id:
 *
 * ```text
 *   `model`: AI model to use for Copilot CLI; can be changed with /model ...
 *     - "claude-opus-5"
 *     - "gpt-5.6-sol"
 * ```
 *
 * Anchoring on the backticked key rather than on a line number or a count is
 * what keeps this working when GitHub adds a model, drops one, or moves the
 * section. The bullet run ends at the first line that is not a quoted bullet,
 * which is the blank line before the next setting.
 *
 * Exported for its test: an unparsed list degrades silently to "no models",
 * which is a supported state, so it needs assertions of its own rather than
 * being inferred from the catalogue's output.
 */
export function parseCopilotModelIds(helpConfig: string | undefined): string[] {
  if (typeof helpConfig !== "string" || helpConfig.length === 0) return []
  const lines = helpConfig.split("\n")
  const ids: string[] = []
  const seen = new Set<string>()
  let inSection = false

  for (const line of lines) {
    if (!inSection) {
      // ``model``: at the start of a setting block. The backticks are what
      // distinguish the setting from the word "model" in prose, of which there
      // is plenty in this help topic.
      if (/^\s*`model`\s*:/.test(line)) inSection = true
      continue
    }
    const bullet = /^\s*-\s*"([^"]+)"\s*$/.exec(line)
    if (!bullet) break
    const id = bullet[1]?.trim()
    if (id === undefined || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  return ids
}

/**
 * The `(choices: "a", "b", ...)` set for one `--flag`, out of wrapped help.
 *
 * Commander wraps option descriptions at the terminal width, so the choice list
 * for `--effort` arrives across three lines:
 *
 * ```text
 *   --effort, --reasoning-effort <level>  Set the reasoning effort level (choices:
 *                                         "none", "minimal", "low", "medium",
 *                                         "high", "xhigh", "max")
 * ```
 *
 * Reading it line by line would therefore return `none, minimal, low, medium`
 * on an 80-column probe and the full set on a wide one — a silent, environment
 * dependent truncation that would then be used to warn a user that `max` is not
 * a real effort. So the row is reassembled first: everything from the option
 * line up to the next option line is joined, whitespace collapsed, and only
 * then is the choice list read.
 *
 * Exported for its test, for the same reason as `parseCopilotModelIds`.
 */
export function parseCopilotChoices(help: string | undefined, flag: string): string[] {
  const row = optionRow(help, flag)
  if (row === undefined) return []
  const start = row.indexOf("(choices:")
  if (start < 0) return []
  const end = row.indexOf(")", start)
  const body = end < 0 ? row.slice(start) : row.slice(start, end)

  const values: string[] = []
  const seen = new Set<string>()
  for (const match of body.matchAll(/"([^"]*)"/g)) {
    const value = match[1]?.trim()
    // Verbatim, and deliberately so: the string that goes into `choice.id` is
    // the string that has to go back to Copilot for it to be accepted. No
    // lower-casing, no mapping onto `SEAT_VARIANTS`, no dropping of a level
    // Observer has not seen before.
    if (value === undefined || value.length === 0 || seen.has(value)) continue
    seen.add(value)
    values.push(value)
  }
  return values
}

/**
 * Whether the installed CLI itself documents `auto` as a model.
 *
 * `auto` is not in the `help config` bullet list, so the only honest basis for
 * offering it is the `--model` description saying so. On a build that stops
 * saying it, it stops being offered.
 */
export function helpDeclaresAutoModel(help: string | undefined): boolean {
  const row = optionRow(help, "--model")
  return row !== undefined && /'auto'|"auto"/.test(row)
}

/**
 * One option's full row, unwrapped, or undefined when the flag is absent.
 *
 * An option row begins at column 2 with a dash; every following line that is
 * more deeply indented is a continuation of it. That is the whole grammar, and
 * it is stable across commander versions in a way that a fixed column offset is
 * not.
 */
function optionRow(help: string | undefined, flag: string): string | undefined {
  if (typeof help !== "string" || help.length === 0) return undefined
  const lines = help.split("\n")
  const parts: string[] = []

  for (const line of lines) {
    const isOptionStart = /^ {1,4}-/.test(line)
    if (parts.length === 0) {
      if (!isOptionStart) continue
      // Prefix match on the trimmed row so `--effort, --reasoning-effort` is
      // found by `--effort`, and `--model` does not match `--mode`.
      const trimmed = line.trimStart()
      if (!trimmed.startsWith(`${flag} `) && !trimmed.startsWith(`${flag},`) && trimmed !== flag) continue
      parts.push(trimmed)
      continue
    }
    // Collecting continuations. A new option row, or a dedent out of the
    // options block, ends this one.
    if (isOptionStart || line.trim().length === 0) break
    parts.push(line.trim())
  }

  if (parts.length === 0) return undefined
  return parts.join(" ").replace(/\s+/g, " ")
}

/* -------------------------------------------------------------------------- */
/* Descriptors                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The option descriptors every Copilot model carries.
 *
 * Two decisions worth stating plainly, because both are refusals:
 *
 *  1. **Effort is emitted for every model, and it is a *global* choice set.**
 *     Copilot exposes reasoning effort as one CLI flag with one closed set of
 *     levels; nothing in `--help`, `help config` or the docs says which models
 *     honour which level. So the descriptor carries the host's whole ladder for
 *     every model, and `diagnose` correspondingly validates an effort against
 *     that global set rather than against a per-model one. This is the opposite
 *     of the Claude adapter's per-model gating, and the difference is not
 *     stylistic: Claude publishes per-model capability, Copilot does not, and
 *     inventing a per-model subset would be Observer asserting something no
 *     source supports.
 *
 *  2. **`contextTier` is recognised but never rendered as a control.**
 *     `copilot help config` says the tier is "for tiered-pricing models", and
 *     gives no machine-readable way to say which models those are. A picker
 *     that offers `long_context` on a model that silently ignores it is exactly
 *     the false control this codebase refuses — the user believes they bought
 *     context they are not getting, and may believe they are being billed for
 *     it. `diagnose` still validates the value when a config sets it by hand,
 *     so nothing is lost except a promise Observer cannot keep.
 */
function descriptorsFor(efforts: readonly string[]): ModelOptionDescriptor[] {
  if (efforts.length === 0) return []
  const choices: ModelOptionChoice[] = efforts.map((value) => ({ id: value, label: value }))
  // No `isDefault` and no `currentValue`: Copilot's help declares the ladder
  // but never says which rung it stands on when the flag is omitted. Marking a
  // guess as the default would put a checkmark next to a level the host may not
  // be using.
  return [{ id: COPILOT_REASONING_OPTION, label: "Reasoning effort", type: "select", choices }]
}

/* -------------------------------------------------------------------------- */
/* Adapter construction                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Builds a Copilot adapter over injected surroundings.
 *
 * The default export is one of these over the real environment. The factory
 * exists because everything interesting about this adapter is a failure mode of
 * a subprocess, and a test that has to install Copilot — and authenticate it to
 * GitHub — to exercise a timeout is a test nobody runs and nobody should run.
 */
export function createCopilotAdapter(options: CopilotAdapterOptions = {}): HostSeatAdapter {
  const env = options.env ?? process.env
  const readHome = options.homeDir ?? homedir
  const binary = options.binaryPath && options.binaryPath.length > 0 ? options.binaryPath : DEFAULT_BINARY
  const budgetMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now
  const spawn = options.spawn ?? defaultSpawn
  const cache = new Map<string, CacheEntry>()

  /**
   * Where this install keeps its config, its MCP definitions and its GitHub
   * credentials.
   *
   * `COPILOT_HOME` first because that is the switch Copilot itself honours
   * (`copilot help environment`) and the one Observer's own hook installer
   * already resolves — `copilotHooksPath()` in `packages/cli/src/install.ts`
   * writes `hooks/observer.json` under exactly this directory. `~/.copilot` is
   * the default every install has.
   *
   * Note what this function does *not* do: it computes a string and returns it.
   * It does not stat it, list it, or read a byte out of it. Naming the
   * directory so the CLI can find its own token is the entirety of Observer's
   * relationship with it.
   */
  function resolveHome(): string {
    const configured = env["COPILOT_HOME"]
    if (typeof configured === "string" && configured.trim().length > 0) return configured.trim()
    return join(readHome(), ".copilot")
  }

  function resolveProfile(): HostProfile {
    const home = resolveHome()
    return {
      id: COPILOT_DEFAULT_PROFILE,
      host: "copilot" as HostKind,
      // The home is in the label only when it is not the default one, so the
      // common case reads "GitHub Copilot CLI" and the two-account case is
      // still distinguishable at a glance.
      label:
        home === join(readHome(), ".copilot") ? "GitHub Copilot CLI" : `GitHub Copilot CLI (${home})`,
      binaryPath: binary,
      homePath: home,
    }
  }

  /**
   * Environment for a probe child.
   *
   * Three assignments, and every one of them is a narrowing:
   *
   *  - `COPILOT_HOME` pins the probe to the profile we mean rather than
   *    whichever one the daemon happened to be started under. Verified against
   *    1.0.80 that a help topic creates nothing in a fresh directory.
   *  - `COPILOT_AUTO_UPDATE=false` stops a config-screen keystroke from
   *    triggering a background upgrade of the user's toolchain. See the module
   *    header.
   *  - `NO_COLOR=1` keeps ANSI escapes out of the text this module parses. A
   *    colourised help topic would silently defeat the bullet and choice
   *    regexes and produce an empty catalogue on a working install.
   *
   * Everything else is inherited, because the child needs a `PATH`, a `HOME`
   * and whatever a version manager put there to be launchable at all. `HOME` in
   * particular is passed through untouched and must never be assigned here: on
   * a machine where Copilot's credential resolution is keyed on the real home,
   * overriding it makes an authenticated CLI report itself logged out — the
   * same trap the Claude adapter documents at `claudeConfigDir`.
   */
  function probeEnv(home: string): NodeJS.ProcessEnv {
    return { ...env, COPILOT_HOME: home, COPILOT_AUTO_UPDATE: "false", NO_COLOR: "1" }
  }

  function probe(profile: HostProfile): ModelCatalogue {
    const home = profile.homePath ?? resolveHome()
    const source = `${binary} help config (COPILOT_HOME=${home})`
    const warnings: string[] = []
    const deadline = now() + budgetMs

    const remainingFor = (): number => Math.max(deadline - now(), MIN_PROBE_TIMEOUT_MS)

    // Probe one: the model inventory. This is the probe that decides whether
    // there is a catalogue at all, so it runs first and gets the fresh budget.
    const config = run(spawn, binary, ["help", "config"], probeEnv(home), remainingFor())
    if (config.kind === "failure") {
      warnings.push(describeFailure(config, binary, budgetMs, "help config"))
      return manualCatalogue(source, warnings)
    }

    const ids = parseCopilotModelIds(config.stdout)
    if (ids.length === 0) {
      warnings.push(
        `"${binary} help config" ran but listed no models, so none are offered. Type a model id by hand, for example "claude-opus-5" — the host has the final say.`,
      )
      return manualCatalogue(source, warnings)
    }

    // Probe two: the option vocabularies. A failure here is *not* fatal — a
    // model list with no effort control is far more useful than no list at all,
    // and the warning says which half is missing.
    let efforts: string[] = []
    let auto = false
    if (deadline - now() <= 0) {
      warnings.push(
        `Copilot did not finish answering within ${budgetMs} ms, so no reasoning-effort levels are offered for these models.`,
      )
    } else {
      const help = run(spawn, binary, ["--help"], probeEnv(home), remainingFor())
      if (help.kind === "failure") {
        warnings.push(
          `${describeFailure(help, binary, budgetMs, "--help")} Models are still listed, but no reasoning-effort levels are offered.`,
        )
      } else {
        efforts = parseCopilotChoices(help.stdout, "--effort")
        auto = helpDeclaresAutoModel(help.stdout)
        if (efforts.length === 0) {
          warnings.push(
            `"${binary} --help" did not declare a set of reasoning-effort levels, so none are offered. Copilot may still accept "--effort" — the host has the final say.`,
          )
        }
      }
    }

    const options = descriptorsFor(efforts)
    const models: CatalogueModel[] = []
    // `auto` first, because it is the choice a user who does not want to think
    // about model ids is looking for, and because Copilot's own help leads with
    // it. Only present when this build's help actually declared it.
    if (auto) models.push({ id: AUTO_MODEL, label: "Auto (Copilot picks)", options: [...options] })
    for (const id of ids) {
      if (id === AUTO_MODEL && auto) continue
      // No `contextWindow`: Copilot's help publishes no per-model context size,
      // and a number invented here would be rendered to the user as fact.
      models.push({ id, label: id, options: [...options] })
    }

    return { models, source, freshness: "live", warnings }
  }

  /**
   * The "nothing to list" answer.
   *
   * `freshness: "unknown"` rather than `"live"`: we did not learn that this
   * Copilot has no models, we failed to learn anything, and the difference is
   * what stops the picker claiming an empty inventory. The accompanying
   * `capabilities().discovery` degrades to `"manual"` so the UI knows to offer
   * a free-text field instead of an empty list.
   */
  function manualCatalogue(source: string, warnings: string[]): ModelCatalogue {
    return { models: [], source, freshness: "unknown", warnings }
  }

  function catalogue(profileId: string): ModelCatalogue {
    // Wrapped whole: the contract is that this function returns a catalogue,
    // and a defect anywhere below — a parser that trips on a help layout nobody
    // anticipated, a launcher that throws where it promised a result — must
    // degrade to "no models, here is why" rather than take down the caller.
    try {
      const profile = resolveProfile()
      if (profileId !== profile.id) {
        return {
          models: [],
          source: `${binary} help config`,
          freshness: "unknown",
          warnings: [
            `Observer has no Copilot profile called "${profileId}", so there is nothing to list models from.`,
          ],
        }
      }

      const key = cacheKey(profile)
      const cached = cache.get(key)
      if (cached && now() - cached.at < cached.ttl) {
        // Memoised, so say memoised. A caller that renders "live" over a
        // ten-minute-old answer is overstating what it knows.
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
        source: `${binary} help config`,
        freshness: "unknown",
        warnings: [`Observer could not read the Copilot model list: ${describeError(error)}.`],
      }
    }
  }

  /** The memoised catalogue for a profile, or undefined when nothing is cached. */
  function cached(profileId: string): ModelCatalogue | undefined {
    const profile = resolveProfile()
    if (profileId !== profile.id) return undefined
    const entry = cache.get(cacheKey(profile))
    // An expired entry is treated as no entry. Warning about an effort against
    // a help topic from two hours and one `copilot update` ago is exactly the
    // kind of confident wrongness this module is built to avoid.
    if (!entry || now() - entry.at >= entry.ttl) return undefined
    return entry.catalogue
  }

  /**
   * The effort ladder this install advertised, from the memoised probe only.
   *
   * Never probes. Diagnosis runs on half-typed input in a TUI, and a config
   * keystroke must not cost a subprocess. With no cached inventory there is no
   * warning at all — silence beats inventing an authority we do not have.
   */
  function cachedEfforts(profileId: string): string[] {
    const entry = cached(profileId)
    if (entry === undefined) return []
    for (const model of entry.models) {
      const descriptor = model.options.find((option) => option.id === COPILOT_REASONING_OPTION)
      const choices = descriptor?.choices ?? []
      // The ladder is global, so the first model that carries it speaks for all
      // of them.
      if (choices.length > 0) return choices.map((choice) => choice.id)
    }
    return []
  }

  /**
   * What is wrong with one Copilot target, and nothing that merely differs.
   *
   * Three rules, and deliberately no fourth:
   *
   *  - A Copilot model is a **bare slug** — `claude-opus-5`, `gpt-5.6-sol`, or
   *    the literal `auto`. The `provider/model` rule OpenCode's adapter applies
   *    is OpenCode's addressing scheme, not a fact about models, and applying it
   *    here would fail `SeatDiagnosis.ok` on a perfectly good config. The only
   *    model this rejects is one that is present and empty, which is a field
   *    the user started filling in and left.
   *  - An option id this adapter does not apply is **`info`**, not an error. It
   *    is preserved in the file untouched, which is the same bargain
   *    `SeatTarget`'s index signature makes.
   *  - A value outside the host's declared set is a **warning**, never an error.
   *    Copilot has the final say, and a warning the user can overrule beats an
   *    error that blocks a config that would have worked.
   */
  function diagnose(profileId: string, targetId: string, target: SeatTarget, employeeId: string): SeatIssue[] {
    try {
      const issues: SeatIssue[] = []
      const basePath = `seats.employees.${employeeId}.targets.${targetId}`
      const add = (
        code: SeatIssue["code"],
        severity: SeatIssueSeverity,
        suffix: string,
        message: string,
      ): void => {
        issues.push({
          code,
          severity,
          path: suffix ? `${basePath}.${suffix}` : basePath,
          employeeId,
          targetId,
          host: "copilot",
          message,
        })
      }

      const rawModel = typeof target?.model === "string" ? target.model : undefined
      const model = rawModel?.trim()

      // A whitespace-only model is the same finding as an empty one: it is a
      // value that names nothing, and it is distinguishable from an omitted
      // model, which legitimately means "inherit the session's".
      if (rawModel !== undefined && (model === undefined || model.length === 0)) {
        add(
          "malformed-model",
          "error",
          "model",
          'This Copilot target sets an empty model. Copilot models are bare slugs, for example "claude-opus-5" or "auto" — write one, or remove the field.',
        )
        return issues
      }

      const options = Array.isArray(target?.options) ? target.options : []
      if (options.length === 0) return issues

      // `options-without-model` is host-agnostic and `diagnoseSeats` already
      // raises it. Repeating it here would put two rows in the TUI for one
      // mistake.
      if (model === undefined || model.length === 0) return issues

      const efforts = cachedEfforts(profileId)

      for (const option of options) {
        const id = typeof option?.id === "string" ? option.id : ""
        if (id.length === 0) continue
        const suffix = `options.${id}`

        if (!(COPILOT_OPTION_IDS as readonly string[]).includes(id)) {
          add(
            "unknown-field",
            "info",
            suffix,
            `Observer does not apply "${id}" on Copilot yet (it applies ${COPILOT_OPTION_IDS.join(", ")}). It is preserved in the file untouched.`,
          )
          continue
        }

        if (id === COPILOT_REASONING_OPTION) diagnoseEffort(option.value, efforts, add)
        else diagnoseContextTier(option.value, add)
      }

      return issues
    } catch {
      // Same contract as `catalogue`: a diagnosis that throws is worse than no
      // diagnosis, because the caller is a config screen holding half a line of
      // someone's typing.
      return []
    }
  }

  /**
   * Cache identity: profile, binary and home.
   *
   * All three, because they are what decides the answer. A profile repointed at
   * a vendored binary is a different Copilot build with a different model list,
   * and a different home is a different account. Any of them changing must miss
   * the cache rather than serve the other one's inventory.
   */
  function cacheKey(profile: HostProfile): string {
    return `${profile.id}\u0000${binary}\u0000${profile.homePath ?? ""}`
  }

  return {
    kind: "copilot" as HostKind,
    label: "GitHub Copilot CLI",

    profiles(): HostProfile[] {
      // One profile per home, and one home per environment: Copilot routes an
      // account by `COPILOT_HOME`, so two accounts are two homes and there is
      // nothing else here to enumerate. Listing profiles must cost nothing —
      // no probe, no stat, no read.
      try {
        return [resolveProfile()]
      } catch {
        return []
      }
    },

    catalogue,
    diagnose,

    /**
     * What Observer can and cannot do to a Copilot seat today.
     *
     * ### `discovery`
     *
     * `"live"`, because the inventory is a probe of the install in front of us
     * — degraded to `"manual"` once a probe for this profile has actually come
     * back empty, so a UI facing a Copilot that will not answer offers a text
     * field instead of an empty list. This reads the cache only; it never
     * probes, so `capabilities()` stays free to call on a render path.
     *
     * ### `childModel` and `childReasoning`: `"unsupported"`
     *
     * This is the finding the brief expected to go the other way, so it is
     * worth being exact about what is and is not true.
     *
     * Copilot CLI **does** have a per-subagent model and effort selection.
     * `copilot help config` documents
     * `subagents.agents.<agent-name>`: "per-subagent model, effortLevel, and
     * contextTier selection", each settable to `"inherit"`, configured with the
     * `/subagents` slash command. So the host capability is real, and — unlike
     * Claude — the join is even plausible, because Copilot's `subagentStart`
     * hook reports `agentName` and that is precisely the key this setting is
     * filed under.
     *
     * What is missing is Observer's path to it, on three counts:
     *
     *  1. It is **persistent configuration, not a per-delegation parameter.**
     *     There is no argument on a delegation that carries a model. Setting it
     *     changes the model for every future delegation to that agent name in
     *     that profile, including ones Observer did not initiate. A seat is a
     *     per-employee statement; this knob is a global one wearing a
     *     per-agent label.
     *  2. **The parent does not place the call.** Both `--help` and the docs
     *     describe delegation as something the model chooses to do. There is no
     *     control point at which a parent hands a child a model.
     *  3. **Writing it means writing into the credential directory.** The
     *     setting lives in `$COPILOT_HOME/config.json`, in the same directory
     *     as the CLI's stored GitHub token. Observer read-modify-writing that
     *     file — concurrently with a running CLI that also writes it — to gain
     *     an unproven capability is a trade this adapter declines. A corrupted
     *     `config.json` next to a token store is a much worse outcome than a
     *     seat that does not set a child model.
     *
     * So: `"unsupported"`, which is a statement about Observer and not about
     * Copilot. It becomes `"experimental"` when someone has a measured,
     * concurrency-safe writer for `subagents.agents.<name>` that does not touch
     * anything else in that directory, and `"supported"` when that has been run
     * against real Copilot versions. Not before: a seat UI reads these flags to
     * decide whether to tell a user their employee "runs Opus", and that
     * sentence is a claim about their bill.
     *
     * ### `requiresReload`
     *
     * `true`. Every mechanism Observer could plausibly use to set a Copilot
     * model — `--model`, `--effort`, `COPILOT_MODEL` — is read when the process
     * starts. The controls that take effect live (`/model`, `/subagents`) are
     * interactive slash commands typed by a human into a running session, which
     * Observer does not drive.
     */
    capabilities(profileId: string): HostCapabilities {
      let discovery: HostCapabilities["discovery"] = "live"
      try {
        const entry = cached(profileId)
        if (entry !== undefined && entry.models.length === 0) discovery = "manual"
      } catch {
        // A capability report that throws would take out the config screen it
        // is describing. An optimistic "live" is the safe failure here: it
        // costs a list that turns out empty, not a crash.
      }
      return { discovery, childModel: "unsupported", childReasoning: "unsupported", requiresReload: true }
    },
  }
}

/** The adapter over the real environment. Constructing it spawns nothing. */
export const copilotAdapter: HostSeatAdapter = createCopilotAdapter()

/* -------------------------------------------------------------------------- */
/* Option diagnosis                                                           */
/* -------------------------------------------------------------------------- */

type AddIssue = (
  code: SeatIssue["code"],
  severity: SeatIssueSeverity,
  suffix: string,
  message: string,
) => void

/**
 * The `effortLevel` value's findings.
 *
 * Validated against the *global* ladder this install advertised, not against a
 * per-model one — Copilot publishes no per-model effort support, so a per-model
 * check would be Observer asserting something it cannot know. With no cached
 * probe there is no ladder and therefore no finding.
 */
function diagnoseEffort(value: unknown, efforts: readonly string[], add: AddIssue): void {
  const suffix = `options.${COPILOT_REASONING_OPTION}`

  if (typeof value !== "string") {
    add(
      "unrecognised-variant",
      "warning",
      suffix,
      `"${COPILOT_REASONING_OPTION}" takes a named level, not ${typeof value === "boolean" ? "a switch" : "this value"}. Set it to one of the levels Copilot offers, or drop it.`,
    )
    return
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) return
  if (efforts.length === 0) return
  if (efforts.includes(trimmed)) return

  add(
    "unrecognised-variant",
    "warning",
    suffix,
    `"${trimmed}" is not a reasoning effort this Copilot advertises (${efforts.join(", ")}). It may still work — the host has the final say.`,
  )
}

/**
 * The `contextTier` value's findings.
 *
 * Checked against the two tiers `copilot help config` names in prose rather
 * than against a parsed set, because — unlike the effort ladder — this one is
 * not published as a machine-readable `(choices: ...)` list anywhere the probe
 * reads. Two tiers, both warnings, and no descriptor is ever offered for this
 * option: see `descriptorsFor`.
 */
function diagnoseContextTier(value: unknown, add: AddIssue): void {
  const suffix = `options.${COPILOT_CONTEXT_TIER_OPTION}`

  if (typeof value !== "string") {
    add(
      "unrecognised-variant",
      "warning",
      suffix,
      `"${COPILOT_CONTEXT_TIER_OPTION}" takes a named tier ("default" or "long_context"), not ${typeof value === "boolean" ? "a switch" : "this value"}.`,
    )
    return
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) return
  if (trimmed === "default" || trimmed === "long_context") return

  add(
    "unrecognised-variant",
    "warning",
    suffix,
    `"${trimmed}" is not a context tier Copilot documents ("default", "long_context"). It applies only to tiered-pricing models in any case, so it may have no effect.`,
  )
}

/* -------------------------------------------------------------------------- */
/* Probe plumbing                                                             */
/* -------------------------------------------------------------------------- */

interface ProbeSuccess {
  kind: "ok"
  stdout: string
}

interface ProbeFailure {
  kind: "failure"
  reason: "unstarted" | "timeout" | "exit"
  detail?: string
  status?: number | null
}

/**
 * One help topic, one process.
 *
 * stdout is judged *before* the exit status, on purpose. A CLI that printed a
 * complete help topic and then exited non-zero — an update check that failed, a
 * telemetry flush that timed out — has still told us everything we asked for,
 * and failing the probe on that would throw away a good model list over an
 * unrelated bug. The status is only consulted when there is no output to use.
 */
function run(
  spawn: CopilotSpawn,
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): ProbeSuccess | ProbeFailure {
  let result: CopilotSpawnResult
  try {
    result = spawn(binary, args, { env, timeoutMs })
  } catch (error) {
    // A launcher that throws instead of reporting is still just a host that did
    // not answer.
    return { kind: "failure", reason: "unstarted", detail: describeError(error) }
  }

  if (result.failure !== undefined) return { kind: "failure", reason: "unstarted", detail: result.failure }

  const stdout = typeof result.stdout === "string" ? result.stdout : ""
  if (stdout.trim().length > 0) return { kind: "ok", stdout }
  if (result.timedOut === true) return { kind: "failure", reason: "timeout" }
  return { kind: "failure", reason: "exit", status: result.status }
}

/**
 * One sentence a user can act on, for each way a probe can fail.
 *
 * Every branch names the binary or the budget, because the two questions a user
 * has are "is it installed" and "is it hanging", and a warning that says neither
 * sends them to a log file. Nothing here interpolates the child's stderr,
 * because the child's stderr is never read.
 */
function describeFailure(failure: ProbeFailure, binary: string, budgetMs: number, topic: string): string {
  switch (failure.reason) {
    case "unstarted":
      return `Copilot could not be started: "${binary}" ${failure.detail ?? "did not run"}. Install GitHub Copilot CLI or set this profile's binary path, so no Copilot models are listed.`
    case "timeout":
      return `"${binary} ${topic}" did not answer within ${budgetMs} ms, so no Copilot models are listed.`
    default:
      return `"${binary} ${topic}" printed nothing${failure.status === null || failure.status === undefined ? "" : ` and exited with code ${failure.status}`}, so no Copilot models are listed. This usually means the installed Copilot is older than the help topics Observer reads.`
  }
}

/**
 * `spawnSync`, mapped onto the narrow seam.
 *
 * Every field is a containment decision:
 *
 *  - `stdio[0] = "ignore"`. stdin is closed, so a CLI that decided to prompt —
 *    for a login, for a trusted-folder confirmation — gets EOF and exits
 *    instead of hanging a config screen. It is also why the seam carries no
 *    `input`: there is no channel to write down.
 *  - `stdio[2] = "ignore"`. stderr is the stream a CLI prints auth failures on,
 *    those messages routinely quote a token prefix or an account address, and
 *    the surest way never to log one is never to read it.
 *  - A 512 KB buffer. `copilot help config` is ~15 KB; this is room for a much
 *    chattier future build and still a ceiling on one that decides to stream
 *    its logs at us.
 *  - `shell` is left off, so the argv is passed to `execvp` verbatim and a
 *    binary path containing shell metacharacters cannot become a command.
 */
function defaultSpawn(
  binary: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): CopilotSpawnResult {
  const result = spawnSync(binary, [...args], {
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: options.timeoutMs,
    maxBuffer: 512 * 1024,
  })

  const spawnResult: CopilotSpawnResult = {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    status: result.status,
  }
  const error = result.error as (Error & { code?: string }) | undefined
  if (error?.code === "ETIMEDOUT") spawnResult.timedOut = true
  else if (error !== undefined) spawnResult.failure = describeSpawnError(error)
  // Killed without an error object — a `timeout` on some platforms reports only
  // the signal — is still a timeout.
  else if (result.signal !== null && result.signal !== undefined) spawnResult.timedOut = true
  return spawnResult
}

function describeSpawnError(error: Error & { code?: string }): string {
  if (error.code === "ENOENT") return "was not found on PATH"
  if (error.code === "EACCES") return "is not executable"
  return `could not be launched (${error.code ?? error.message})`
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "unknown error"
}

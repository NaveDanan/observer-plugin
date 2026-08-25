import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  contextTierWindowsFor,
  contextTiersFor,
  contextWindowsFor,
  formatContext,
  type ContextTierWindows,
} from "../models.js"
import { probeCopilotEntitlement, type CopilotEntitlementProbe } from "./copilot-entitlement.js"
import type { HostKind } from "../providers.js"
import type { SeatIssue, SeatIssueSeverity, SeatTarget } from "../seats.js"
import type {
  CatalogueModel,
  HostCapabilities,
  HostProfile,
  HostSeatAdapter,
  ModelCatalogue,
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
 * Note that a descriptor is emitted for this id only on models a snapshot says
 * are priced in context tiers — see `descriptorsFor` for why the eligibility
 * question has to be answered before the control can be offered at all.
 */
export const COPILOT_CONTEXT_TIER_OPTION = "contextTier"

/** The two option ids this adapter understands. Nothing else is a Copilot option. */
export const COPILOT_OPTION_IDS = [COPILOT_REASONING_OPTION, COPILOT_CONTEXT_TIER_OPTION] as const

/** The Copilot fields a generated employee agent can apply. */
export interface CopilotSeatTarget {
  model: string
  effortLevel?: string
  contextTier?: string
}

export const COPILOT_SEAT_AGENT_MARKER = "observer:copilot-seat-agent v1"

/**
 * Decodes one Copilot target without applying policy from another host.
 *
 * The same decoder is used by diagnosis and native-agent generation so a saved
 * target cannot mean two subtly different things.
 */
export function readCopilotTarget(target: SeatTarget | undefined): CopilotSeatTarget | undefined {
  if (target?.host !== "copilot" || typeof target.model !== "string") return undefined
  const model = target.model.trim()
  if (model.length === 0) return undefined

  const result: CopilotSeatTarget = { model }
  for (const option of Array.isArray(target.options) ? target.options : []) {
    if (typeof option.value !== "string" || option.value.trim().length === 0) continue
    if (option.id === COPILOT_REASONING_OPTION) result.effortLevel = option.value.trim()
    if (option.id === COPILOT_CONTEXT_TIER_OPTION) result.contextTier = option.value.trim()
  }
  return result
}

/** Stable plugin-qualified custom-agent id used by generated settings. */
export function copilotSeatAgentName(employeeId: string): string {
  const slug = String(employeeId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `observer-${slug.length > 0 ? slug : "unknown"}`
}

/** Runtime id Copilot assigns to an agent contributed by the Observer plugin. */
export function copilotSeatAgentReference(employeeId: string): string {
  return `observer:${copilotSeatAgentName(employeeId)}`
}

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
 * The models.dev provider whose model ids are Copilot CLI's model ids.
 *
 * They are the same strings — `claude-opus-5`, `gpt-5.6-sol`, `kimi-k3` — and
 * that is not a coincidence: the snapshot's `github-copilot` entry is the
 * published record of what this host serves. It is consulted for context
 * windows only, never for the model list itself: the binary in front of the
 * user decides what exists, and a snapshot that has gone stale must not be
 * able to add or remove a model from the picker.
 */
const COPILOT_CATALOGUE_PROVIDER = "github-copilot"

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
  /**
   * Context windows by bare model id, for the Context column.
   *
   * Injected so a test can state the sizes it expects instead of depending on
   * whatever models.dev snapshot the machine running it happens to hold.
   * Defaults to the `github-copilot` provider of OpenCode's snapshot.
   */
  contextWindows?: () => Map<string, number>
  /**
   * Bare model ids that Copilot prices in context tiers.
   *
   * Injected for the same reason as `contextWindows`: which models are tiered
   * is a fact about a snapshot on disk, and a test must be able to state it.
   * Defaults to the `github-copilot` provider of OpenCode's snapshot.
   */
  contextTiers?: () => Set<string>
  /** Total capacities behind Copilot's `default` and `long_context` tiers. */
  contextTierWindows?: () => Map<string, ContextTierWindows>
  /**
   * Which models this account may actually run.
   *
   * Injected so a test never speaks ACP to a real Copilot, and so the default —
   * which spawns a child and leaves a session behind — is opt-outable by any
   * caller that would rather offer everything than pay for the answer. Defaults
   * to the real probe. See `copilot-entitlement.ts` for why it is not a
   * `CopilotSpawn`.
   */
  entitlement?: CopilotEntitlementProbe
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
 *  2. **`contextTier` is emitted only for models a snapshot says are tiered.**
 *     `copilot help config` calls the tier a setting "for tiered-pricing
 *     models" and names none of them, and for as long as that was the only
 *     source the control was withheld outright — a picker that offers
 *     `long_context` on a model which silently ignores it is exactly the false
 *     control this codebase refuses, because the user believes they bought
 *     context they are not getting and may believe they are being billed for
 *     it.
 *
 *     models.dev closes that gap. Its `github-copilot` entries carry
 *     `cost.tiers[].tier.type === "context"` with the over-200K price beside
 *     it, which is not a proxy for "tiered-pricing model" but the tiered price
 *     itself. So the tier is offered where that says so, withheld everywhere
 *     else, and withheld for every model when the snapshot is missing — the
 *     control fails closed, back to the behaviour it replaced. The values come
 *     from `--help`'s own `(choices: ...)` list, never from a literal here, so
 *     a build that renames a tier stops offering the old name.
 *
 *     Not to be confused with the `contextWindow` the catalogue carries. That
 *     is a *fact about the model* — how much context it holds — rendered as
 *     text in a column. The tier is a *control*: a value Observer writes to
 *     `subagents.agents.<agent>.contextTier` to change what the host does.
 */
function descriptorsFor(
  efforts: readonly string[],
  tiers: readonly string[],
  tiered: boolean,
  windows?: ContextTierWindows,
): ModelOptionDescriptor[] {
  const descriptors: ModelOptionDescriptor[] = []
  // Reasoning has no declared default. Context does: the host calls its first
  // tier `default`, so omitting the saved value and selecting that tier are the
  // same operation.
  if (efforts.length > 0) {
    descriptors.push({
      id: COPILOT_REASONING_OPTION,
      label: "Reasoning effort",
      type: "select",
      choices: efforts.map((value) => ({ id: value, label: value })),
    })
  }
  if (tiered && tiers.length > 0) {
    descriptors.push({
      id: COPILOT_CONTEXT_TIER_OPTION,
      label: "Context tier",
      type: "select",
      choices: tiers.map((value) => {
        const context =
          value === "default" ? windows?.standard : value === "long_context" ? windows?.maximum : undefined
        return {
          id: value,
          label: context === undefined ? value : formatContext(context),
          ...(value === "default" ? { isDefault: true } : {}),
        }
      }),
    })
  }
  return descriptors
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
  const readContextWindows = options.contextWindows ?? (() => contextWindowsFor(COPILOT_CATALOGUE_PROVIDER))
  const readContextTiers = options.contextTiers ?? (() => contextTiersFor(COPILOT_CATALOGUE_PROVIDER))
  const readContextTierWindows = options.contextTierWindows ?? (() => contextTierWindowsFor(COPILOT_CATALOGUE_PROVIDER))
  const readEntitlement: CopilotEntitlementProbe =
    options.entitlement ??
    ((probeBinary, probeOptions) =>
      probeCopilotEntitlement(probeBinary, probeOptions, {
        invocation: (value) => {
          const built = copilotSpawnInvocation(value, ["--acp", "--disable-builtin-mcps"])
          return { command: built.command, args: built.args, verbatim: built.windowsVerbatimArguments === true }
        },
      }))
  const cache = new Map<string, CacheEntry>()
  const failed = new Set<string>()
  /**
   * The `--context` ladder each profile's last probe read, whatever it found.
   *
   * Separate from the catalogue because the two answer different questions.
   * The descriptors say which models *may* be tiered, which depends on a
   * models.dev snapshot; this says which tier *names* the installed CLI
   * accepts, which does not. `diagnose` needs the second to judge a
   * hand-written value on a machine where the first is unavailable.
   */
  const tierLadders = new Map<string, string[]>()

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
    let config = run(spawn, binary, ["help", "config"], probeEnv(home), remainingFor())
    // A cold Copilot process can exit before Commander prints the topic. Retry
    // once while the launch budget remains instead of turning that one miss into
    // an empty picker for the rest of this config session.
    if (config.kind === "failure" && deadline - now() > 0) {
      config = run(spawn, binary, ["help", "config"], probeEnv(home), remainingFor())
    }
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
    let tiers: string[] = []
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
        tiers = parseCopilotChoices(help.stdout, "--context")
        auto = helpDeclaresAutoModel(help.stdout)
        if (efforts.length === 0) {
          warnings.push(
            `"${binary} --help" did not declare a set of reasoning-effort levels, so none are offered. Copilot may still accept "--effort" — the host has the final say.`,
          )
        }
      }
    }

    // Copilot's own help publishes no per-model context size. models.dev does,
    // under the `github-copilot` provider — the same snapshot that fills the
    // column for OpenCode — so the number is looked up rather than invented,
    // and a model the snapshot has never heard of keeps an empty cell unless it
    // is Copilot's explicit `-fast` alias for a published base model.
    const contexts = readContextWindows()
    // The same snapshot says which models are priced in context tiers, which is
    // the only machine-readable answer to `help config`'s "for tiered-pricing
    // models". A model it does not list gets no tier control.
    const tiered = readContextTiers()
    const tierWindows = readContextTierWindows()
    // Which of those models this account may actually run. `help config` names
    // the product's whole inventory; entitlement is a property of the seat, and
    // the gap between the two is what makes a picker offer models that fail at
    // use time. The answer arrives from a cache a background refresh fills, so
    // the first open of a picker greys nothing out and says nothing about it —
    // see `CatalogueModel.available` for why the third state is not a warning.
    const entitled = readEntitlement(binary, { env: probeEnv(home), timeoutMs: budgetMs }).models
    // Remembered whole, not read back off the descriptors: the descriptor is
    // emitted only on tiered models, so a machine with no snapshot would carry
    // the ladder nowhere and `diagnose` would fall silent on a typo'd tier.
    tierLadders.set(cacheKey(profile), tiers)
    const plain = descriptorsFor(efforts, tiers, false)
    const models: CatalogueModel[] = []
    // `auto` first, because it is the choice a user who does not want to think
    // about model ids is looking for, and because Copilot's own help leads with
    // it. Only present when this build's help actually declared it.
    // No context window on `auto`: it routes to a model chosen per request, so
    // there is no one size to state. No tier either, for the same reason — the
    // model that ends up serving the request is not known here. It is never
    // greyed out: `auto` is a router, not a model, so an account that can run
    // anything at all can run it.
    if (auto) models.push({ id: AUTO_MODEL, label: "Auto (Copilot picks)", options: [...plain] })
    for (const id of ids) {
      if (id === AUTO_MODEL && auto) continue
      const model: CatalogueModel = {
        id,
        label: id,
        options: descriptorsFor(efforts, tiers, tiered.has(id), contextTierWindowsForModel(tierWindows, id)),
      }
      const context = contextWindowFor(contexts, id)
      if (context !== undefined && context > 0) model.contextWindow = context
      if (entitled !== undefined) model.available = entitled.has(id)
      models.push(model)
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
      // Never pin an empty transient answer. The config TUI probes once during
      // launch and can ask again when the picker opens, which is how a host that
      // finishes warming up recovers without making the user restart Observer.
      if (fresh.models.length > 0) {
        failed.delete(key)
        cache.set(key, { at: now(), ttl: SUCCESS_TTL_MS, catalogue: fresh })
      } else {
        cache.delete(key)
        failed.add(key)
      }
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
   *
   * Copilot's effort ladder is global, so the first model carrying the
   * descriptor speaks for all of them.
   */
  function cachedEfforts(profileId: string): string[] {
    const entry = cached(profileId)
    if (entry === undefined) return []
    for (const model of entry.models) {
      const descriptor = model.options.find((option) => option.id === COPILOT_REASONING_OPTION)
      const choices = descriptor?.choices ?? []
      if (choices.length > 0) return choices.map((choice) => choice.id)
    }
    return []
  }

  /**
   * The `--context` ladder this install advertised, from the memoised probe.
   *
   * Read out of `tierLadders` rather than off a descriptor, because a machine
   * with no models.dev snapshot emits no tier descriptor at all yet still has
   * a perfectly good published ladder to judge a hand-written value against.
   *
   * Empty when nothing has been probed yet, which `diagnose` reads as "no
   * grounds to complain" rather than as "no valid values".
   */
  function cachedTiers(profileId: string): string[] {
    const profile = resolveProfile()
    if (profileId !== profile.id) return []
    return tierLadders.get(cacheKey(profile)) ?? []
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
        else diagnoseContextTier(option.value, cachedTiers(profileId), add)
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
     * ### `childModel` and `childReasoning`: `"supported"`
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
     * Observer generates the complete employee roster as custom agents and
     * writes model settings only for configured pins. Copilot chooses an
     * employee from its description; Observer installs no routing hook.
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
        const profile = resolveProfile()
        if (profileId === profile.id && failed.has(cacheKey(profile))) discovery = "manual"
        const entry = cached(profileId)
        if (entry !== undefined && entry.models.length === 0) discovery = "manual"
      } catch {
        // A capability report that throws would take out the config screen it
        // is describing. An optimistic "live" is the safe failure here: it
        // costs a list that turns out empty, not a crash.
      }
      return { discovery, childModel: "supported", childReasoning: "supported", requiresReload: true }
    },
  }
}

function contextWindowFor(contexts: Map<string, number>, modelId: string): number | undefined {
  const direct = contexts.get(modelId)
  if (direct !== undefined) return direct
  // Copilot exposes `claude-opus-4.8-fast` as the low-latency alias of
  // `claude-opus-4.8`; models.dev publishes the base entry only. The alias does
  // not change how many tokens the underlying model accepts.
  if (modelId.endsWith("-fast")) return contexts.get(modelId.slice(0, -"-fast".length))
  return undefined
}

function contextTierWindowsForModel(
  windows: Map<string, ContextTierWindows>,
  modelId: string,
): ContextTierWindows | undefined {
  const direct = windows.get(modelId)
  if (direct !== undefined) return direct
  if (modelId.endsWith("-fast")) return windows.get(modelId.slice(0, -"-fast".length))
  return undefined
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
 * Judged against the tiers this Copilot's `--help` actually declared, the same
 * way an effort is. When nothing has been probed yet the list is empty, and an
 * empty list means silence rather than a complaint against every value — a
 * target written before the first probe is not evidence of a mistake.
 */
function diagnoseContextTier(value: unknown, tiers: readonly string[], add: AddIssue): void {
  const suffix = `options.${COPILOT_CONTEXT_TIER_OPTION}`
  const named = tiers.length > 0 ? tiers.map((tier) => `"${tier}"`).join(", ") : `"default", "long_context"`

  if (typeof value !== "string") {
    add(
      "unrecognised-variant",
      "warning",
      suffix,
      `"${COPILOT_CONTEXT_TIER_OPTION}" takes a named tier (${named}), not ${typeof value === "boolean" ? "a switch" : "this value"}.`,
    )
    return
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) return
  if (tiers.length === 0 || tiers.includes(trimmed)) return

  add(
    "unrecognised-variant",
    "warning",
    suffix,
    `"${trimmed}" is not a context tier this Copilot advertises (${named}). It applies only to tiered-pricing models in any case, so it may have no effect.`,
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
 *  - POSIX launches the binary directly. Windows npm installs expose Copilot
 *    through a `.cmd` shim, which `spawnSync` cannot execute directly, so the
 *    invocation uses `cmd.exe /d /s /c` after rejecting command metacharacters.
 */
function defaultSpawn(
  binary: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): CopilotSpawnResult {
  const invocation = copilotSpawnInvocation(binary, args)
  const result = spawnSync(invocation.command, invocation.args, {
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: options.timeoutMs,
    maxBuffer: 512 * 1024,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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

export interface CopilotSpawnInvocation {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

/** Builds a shell-free invocation, except for the required Windows npm shim. */
export function copilotSpawnInvocation(
  binary: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec = process.env["ComSpec"] ?? process.env["COMSPEC"] ?? "cmd.exe",
): CopilotSpawnInvocation {
  if (platform !== "win32") return { command: binary, args: [...args] }

  const values = [binary, ...args]
  if (values.some((value) => /[\r\n"%!&|<>^]/.test(value))) {
    throw new Error("Copilot binary or arguments contain unsupported Windows command characters")
  }
  const command = values.map((value) => `"${value}"`).join(" ")
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${command}"`],
    windowsVerbatimArguments: true,
  }
}

function describeSpawnError(error: Error & { code?: string }): string {
  if (error.code === "ENOENT") return "was not found on PATH"
  if (error.code === "EACCES") return "is not executable"
  return `could not be launched (${error.code ?? error.message})`
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "unknown error"
}

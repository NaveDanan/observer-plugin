import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import type { HostKind, ProviderInstanceConfig } from "../providers.js"
import type { SeatIssue, SeatIssueSeverity, SeatTarget, SeatTargetOption } from "../seats.js"
// Type-only, and deliberately so. `./types.js` is owned by ticket 02 and was
// still unwritten when this file landed; `import type` is erased by the
// bundler, so this module loads and its tests run whether or not that file
// exists yet. When it lands, the compiler starts checking this against it.
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
 * The Claude Code host adapter: profiles, model catalogue, seat diagnosis.
 *
 * Claude is the host that most tempts an adapter into lying, in three separate
 * ways, and every design decision below is one of those three being refused.
 *
 *  1. **Discovery would cost credentials.** The obvious way to build a model
 *     list is to ask the agent SDK. Doing that runs Claude Code's
 *     initialisation, which resolves an account, a subscription tier, a token
 *     source and an API provider — real auth work, with real side effects, on
 *     a user who only opened a config screen. So discovery here is a versioned
 *     built-in list gated by `claude --version`, and nothing else. The probe
 *     is one argv-only subprocess that reads a version string. It never opens
 *     a credential file, never touches a keychain, and never writes anything.
 *     `capabilities().discovery` says `"cached"` because that is what it is.
 *
 *  2. **Claude's model options are not one effort field.** Effort, context
 *     window, fast mode and per-model thinking are four independent controls
 *     with four different lifetimes, and collapsing them into Observer's
 *     single legacy `variant` would produce a UI that offers `high` on a model
 *     that has no effort scale and hides a thinking toggle on the one model
 *     that does. `CatalogueModel.options` is therefore a list of descriptors,
 *     each emitted only for models that actually declare it.
 *
 *  3. **Child control is unproven.** Claude's agent-definition contract really
 *     does carry a per-subagent model and effort, so it is tempting to report
 *     `childModel: "supported"`. Observer has no verified path to set it — see
 *     `CLAUDE_CAPABILITIES` — and a capability flag is a promise the seat UI
 *     makes to the user about their bill. It stays `"unsupported"` until a
 *     generated definition plus a `PreToolUse` rewrite has been measured
 *     against real Claude Code versions.
 *
 * Neither `catalogue()` nor `diagnose()` throws. Both are called from a TUI on
 * half-typed input and from the daemon on a config written on another machine;
 * an exception there takes out a config screen, and an empty-but-warned result
 * is always the better answer.
 */

/* -------------------------------------------------------------------------- */
/* Profiles                                                                   */
/* -------------------------------------------------------------------------- */

/** The instance id every install has, matching `config.providers`' `host:profile` keys. */
export const CLAUDE_DEFAULT_PROFILE_ID = "claude:default"

/** Resolved from `PATH` unless the profile pins a `binaryPath`. */
export const CLAUDE_DEFAULT_BINARY = "claude"

/**
 * Where a Claude profile keeps its config, and — critically — where it does
 * not.
 *
 * `CLAUDE_CONFIG_DIR` is the one knob that isolates a profile. `HOME` is not,
 * and pointing `HOME` at a profile directory is the specific bug this comment
 * exists to prevent:
 *
 *   On macOS, Claude Code's stored credentials live in the login keychain, and
 *   keychain resolution is keyed on the *user's* home directory. Override
 *   `HOME` and the lookup goes to a keychain that does not exist, the CLI
 *   reports itself as logged out, and the user is told to re-authenticate a
 *   profile that was authenticated the whole time. On Linux it is the same
 *   shape with a different file: `~/.config` moves and the credential appears
 *   missing.
 *
 * So: `CLAUDE_CONFIG_DIR` is set per profile, `HOME` is passed through
 * untouched, and no code path in this module ever assigns to it. The
 * subprocess env in `runClaudeVersion` is the only place the rule could be
 * broken, and it is asserted by a test.
 *
 * Note also what this function does *not* do: it computes a path and returns
 * it. It does not stat it, list it, or read a byte out of it. The profile
 * directory holds `.credentials.json`; Observer's business with it begins and
 * ends at naming it so the CLI can find its own.
 */
export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env["CLAUDE_CONFIG_DIR"]
  if (typeof configured === "string" && configured.length > 0) return configured
  return join(home, ".claude")
}

/* -------------------------------------------------------------------------- */
/* Version gating                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The first `x.y.z` in `claude --version` output, or undefined.
 *
 * The line is decorated (`2.4.1 (Claude Code)`) and the decoration has changed
 * shape across releases, so the parse anchors on the number and ignores
 * everything else rather than matching a full expected line. A build suffix
 * (`2.4.1-beta.3`) yields `2.4.1`: the gate is a feature gate, and a
 * pre-release of a version is close enough to that version for the purpose of
 * deciding whether a model id exists.
 *
 * Exported for its test. Getting this wrong is silent — an unparsed version
 * degrades to "unknown", which is a supported state — so it needs assertions
 * of its own rather than being inferred from the catalogue's output.
 */
export function parseClaudeVersion(output: string | undefined): string | undefined {
  if (typeof output !== "string") return undefined
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(output)
  if (!match) return undefined
  return `${match[1]}.${match[2]}.${match[3]}`
}

/** `-1 | 0 | 1` on dotted numeric versions. Missing components read as 0. */
export function compareClaudeVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0)
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index] ?? 0
    const r = right[index] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/**
 * Whether a feature gated at `since` is available on `version`.
 *
 * An unknown version answers `true`, and that direction is chosen on purpose.
 * The two failure modes are not symmetric:
 *
 *  - Offer a model the installed CLI does not have: the user picks it, the
 *    host rejects it by name, and the message says exactly which model was
 *    wrong. One bad delegation, self-explaining.
 *  - Hide a model the installed CLI does have: the model the user configured
 *    is missing from a list, the seat editor drops them into free text, and
 *    every descriptor for that model — its effort scale, its thinking toggle —
 *    disappears with it. Nothing on screen says why.
 *
 * `models.ts` makes the same call for the same reason (see `sources.include`).
 * The catalogue warns when it is ungated so the UI can say so out loud.
 */
function availableAt(version: string | undefined, since: string | undefined): boolean {
  if (since === undefined) return true
  if (version === undefined) return true
  return compareClaudeVersions(version, since) >= 0
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Values that look like an effort and are not one.
 *
 * `ultrathink` is prompt text. It is typed into a message to make Claude think
 * harder; it has never been an API effort level, and there is no field on any
 * Claude request that accepts it. Sending it as `effort` produces a rejected
 * call at best, and at worst a silently-ignored setting that leaves the user
 * believing they bought reasoning they are not getting and being billed as if
 * they had.
 *
 * Two defences, because one is not enough for a value this easy to mistake:
 *
 *  1. `effortChoices` filters this set out, so it can never reach the picker
 *     as a selectable effort in the first place. Excluding it beats listing it
 *     with a caveat — a caveat is a label, and labels do not survive being
 *     round-tripped through a config file.
 *  2. `hostEffortValue` filters it again at the send site, so a value that
 *     arrives from an old config, a hand-edited file or another adapter still
 *     never reaches a host as an effort.
 */
export const PROMPT_ONLY_EFFORTS: ReadonlySet<string> = new Set(["ultrathink"])

/**
 * The `effort` value that may be sent to Claude, or undefined for "send none".
 *
 * The single gate every caller must go through. Returns undefined for empties,
 * for non-strings, and for prompt-only text — and undefined means *omit the
 * field*, never "send an empty effort", because an empty effort is a value and
 * this function's whole job is to be able to say there isn't one.
 */
export function hostEffortValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (PROMPT_ONLY_EFFORTS.has(trimmed.toLowerCase())) return undefined
  return trimmed
}

/** The graded scale every effort-capable Claude model exposes, weakest first. */
const BASE_EFFORTS = ["low", "medium", "high"] as const

/** The default level, and the one the host uses when the field is omitted. */
const DEFAULT_EFFORT = "medium"

/**
 * The extra level newer Opus builds accept.
 *
 * Version-gated separately from the model because the model shipped first: a
 * CLI old enough to know `claude-opus-4-8` but not `xhigh` will reject the
 * effort while accepting the model, which is exactly the mismatch the research
 * describes as needing an `xhigh` fallback.
 */
const XHIGH_EFFORT = "xhigh"

function effortChoices(withXhigh: boolean): ModelOptionChoice[] {
  const values = withXhigh ? [...BASE_EFFORTS, XHIGH_EFFORT] : [...BASE_EFFORTS]
  return values
    // Defence 1 of 2 for `ultrathink` — see `PROMPT_ONLY_EFFORTS`. The scale
    // above contains no prompt-only value today; this filter is here so that
    // adding one to a table later cannot quietly turn it into a sent effort.
    .filter((value) => !PROMPT_ONLY_EFFORTS.has(value))
    .map((value) => ({ id: value, label: value, ...(value === DEFAULT_EFFORT ? { isDefault: true } : {}) }))
}

/** The four descriptor ids this adapter emits. Nothing else is a Claude option. */
export const CLAUDE_OPTION_IDS = ["effort", "contextWindow", "fastMode", "thinking"] as const

export type ClaudeOptionId = (typeof CLAUDE_OPTION_IDS)[number]

/* -------------------------------------------------------------------------- */
/* The versioned model table                                                  */
/* -------------------------------------------------------------------------- */

interface ClaudeModelGate {
  id: string
  label: string
  contextWindow?: number
  /** Earliest CLI version that knows this id. */
  since: string
  /** Earliest CLI version that accepts an `effort` for it. Absent: no effort scale. */
  effortSince?: string
  /** Earliest CLI version that accepts `xhigh`. Absent: never. */
  xhighSince?: string
  /** Earliest CLI version offering the 1M context selection. Absent: never. */
  longContextSince?: string
  /** Earliest CLI version offering fast mode. Absent: never. */
  fastModeSince?: string
  /** Earliest CLI version offering the thinking toggle. Absent: never. */
  thinkingSince?: string
}

/**
 * The built-in catalogue, gated by CLI version.
 *
 * Static, and that is a deliberate trade rather than a shortcut. The live
 * alternative is an SDK inventory call, which runs credential-sensitive
 * initialisation on a user who is browsing a list (see the module header). A
 * stale entry costs one rejected model name; a live probe costs an auth
 * side effect on every config screen.
 *
 * The gates are per *capability*, not per model, because they do not move
 * together: a model ships, its effort scale arrives, `xhigh` arrives later
 * still, and fast mode arrives across the whole family at once. Folding them
 * into one `since` would either hide a working model or offer a level the CLI
 * rejects.
 *
 * Note which models carry `thinking`: only the Haiku line. Haiku exposes a
 * thinking on/off toggle instead of a graded effort scale, so it declares
 * `thinkingSince` and no `effortSince`. That asymmetry is the reason
 * descriptors are per model — a shared option list would put an effort slider
 * on Haiku and a thinking switch on Opus, and both would do nothing.
 *
 * Aliases (`opus`, `sonnet`, `haiku`) are first-class entries. They are what
 * users actually type, the host resolves them itself, and they track the
 * newest build in their family — so their capability gates are the family's
 * newest, not its oldest.
 */
export const CLAUDE_MODEL_GATES: readonly ClaudeModelGate[] = [
  {
    id: "opus",
    label: "Opus (alias, latest)",
    contextWindow: 200_000,
    since: "1.0.0",
    effortSince: "1.0.0",
    xhighSince: "2.0.0",
    longContextSince: "2.0.0",
    fastModeSince: "2.2.0",
  },
  {
    id: "sonnet",
    label: "Sonnet (alias, latest)",
    contextWindow: 200_000,
    since: "1.0.0",
    effortSince: "1.0.0",
    longContextSince: "1.9.0",
    fastModeSince: "2.2.0",
  },
  {
    id: "haiku",
    label: "Haiku (alias, latest)",
    contextWindow: 200_000,
    since: "1.6.0",
    thinkingSince: "1.6.0",
    fastModeSince: "2.2.0",
  },
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    contextWindow: 200_000,
    since: "2.4.0",
    effortSince: "2.4.0",
    xhighSince: "2.4.0",
    longContextSince: "2.4.0",
    fastModeSince: "2.4.0",
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    contextWindow: 200_000,
    since: "2.0.0",
    effortSince: "2.0.0",
    xhighSince: "2.0.0",
    longContextSince: "2.0.0",
    fastModeSince: "2.2.0",
  },
  {
    id: "claude-opus-4-5",
    label: "Claude Opus 4.5",
    contextWindow: 200_000,
    since: "1.0.0",
    effortSince: "1.0.0",
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    contextWindow: 200_000,
    since: "1.0.0",
    effortSince: "1.0.0",
    longContextSince: "1.9.0",
    fastModeSince: "2.2.0",
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    contextWindow: 200_000,
    since: "1.6.0",
    thinkingSince: "1.6.0",
    fastModeSince: "2.2.0",
  },
]

/**
 * The descriptors one gated model exposes on one CLI version.
 *
 * Every branch is a gate. A descriptor absent from this list is a control the
 * seat UI must not render, and that is the point: the definition of done for
 * this adapter is that a model without a declared `thinking` option does not
 * show a thinking toggle.
 *
 * `contextWindow` is emitted only when the long-context selection exists for
 * this model on this version. A select with one choice is a control that
 * cannot change anything, and rendering one invites the user to believe they
 * chose something.
 */
function descriptorsFor(gate: ClaudeModelGate, version: string | undefined): ModelOptionDescriptor[] {
  const options: ModelOptionDescriptor[] = []

  if (gate.effortSince !== undefined && availableAt(version, gate.effortSince)) {
    options.push({
      id: "effort",
      label: "Reasoning effort",
      type: "select",
      choices: effortChoices(gate.xhighSince !== undefined && availableAt(version, gate.xhighSince)),
    })
  }

  if (gate.longContextSince !== undefined && availableAt(version, gate.longContextSince)) {
    options.push({
      id: "contextWindow",
      label: "Context window",
      type: "select",
      choices: [
        { id: "default", label: "200K (standard)", isDefault: true },
        // The host does the appending, not Observer: the 1M selection is
        // expressed as a `[1m]` suffix on the model id at call time. Storing
        // the suffix in `model` instead would make the stored id fail to match
        // any catalogue entry the next time the picker opened.
        { id: "1m", label: "1M (beta)" },
      ],
    })
  }

  if (gate.fastModeSince !== undefined && availableAt(version, gate.fastModeSince)) {
    options.push({ id: "fastMode", label: "Fast mode", type: "boolean" })
  }

  if (gate.thinkingSince !== undefined && availableAt(version, gate.thinkingSince)) {
    options.push({ id: "thinking", label: "Extended thinking", type: "boolean" })
  }

  return options
}

/* -------------------------------------------------------------------------- */
/* Adapter construction                                                       */
/* -------------------------------------------------------------------------- */

/** Runs `<binary> --version` and returns stdout, or undefined for any failure. */
export type ClaudeVersionRunner = (binary: string, env: NodeJS.ProcessEnv) => string | undefined

export interface ClaudeAdapterOptions {
  /**
   * `config.providers`, so `profiles()` can report the profiles the user
   * actually configured. Absent yields the single implicit default profile,
   * which is what an install that never opened the provider editor has.
   */
  providers?: Record<string, ProviderInstanceConfig>
  /** Overridden in tests. Never mutated, and never read for a credential. */
  env?: NodeJS.ProcessEnv
  /** Overridden in tests so no fixture needs a real home directory. */
  home?: string
  /** Injected in tests. The one place this module spawns anything. */
  runVersion?: ClaudeVersionRunner
  /**
   * Extra model ids to offer on every profile, verbatim.
   *
   * Merged with each profile's own `models` list. Both exist because the two
   * cases are different: a Bedrock or Vertex deployment id belongs to one
   * profile, while a caller assembling a picker may want to pin the ids
   * already present in the seats config so a configured model never vanishes
   * from the list that is about to be shown.
   */
  customModels?: readonly string[]
}

/**
 * `claude --version`, with the profile's config directory and nothing else.
 *
 * Everything about this call is scoped down on purpose:
 *
 *  - `--version` only. No `-p`, no session, no MCP, no SDK entry point. The
 *    CLI prints a string and exits; it has no reason to resolve an account and
 *    no opportunity to mutate auth state.
 *  - `stdio: ["ignore", "pipe", "ignore"]`. stdin closed so a CLI that decided
 *    to prompt gets EOF instead of hanging a config screen; stderr discarded
 *    so a diagnostic mentioning a path, an account or a token fragment cannot
 *    reach a log Observer writes.
 *  - A 4-second timeout and a 64 KB buffer. This runs on a keystroke path.
 *  - `CLAUDE_CONFIG_DIR` set, `HOME` inherited untouched. Setting the config
 *    dir keeps the probe faithful to the selected profile; leaving `HOME`
 *    alone keeps keychain resolution working. See `claudeConfigDir`.
 *  - Every failure returns undefined. A missing binary, a non-zero exit and a
 *    timeout are the same answer here — "no version" — and the catalogue has a
 *    defined behaviour for it.
 */
function defaultRunVersion(binary: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    return execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
      maxBuffer: 64 * 1024,
      env,
    })
  } catch {
    return undefined
  }
}

/**
 * Model ids a profile pins by hand, from its passthrough `models` field.
 *
 * Read through a cast because `ProviderInstanceConfig` declares no index
 * signature: `models` is a key the schema preserves but does not name, which
 * is exactly the case the passthrough exists for. Every element is re-checked
 * as a non-empty string, so a hand-edited `"models": "opus"` or
 * `"models": [null]` costs the list and nothing around it.
 */
function profileCustomModels(instance: ProviderInstanceConfig | undefined): string[] {
  const raw = (instance as Record<string, unknown> | undefined)?.["models"]
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
}

interface ResolvedProfile {
  profile: HostProfile
  binary: string
  customModels: string[]
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): HostSeatAdapter {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const runVersion = options.runVersion ?? defaultRunVersion
  const pinned = (options.customModels ?? []).filter((value) => value.trim().length > 0)

  /**
   * One probe per binary per adapter instance.
   *
   * A seat editor re-renders on every keystroke and calls `catalogue()` each
   * time. Without this, browsing a model list spawns a subprocess per
   * character — which is a self-inflicted resource problem and, more to the
   * point, turns one bounded touch of the user's Claude install into hundreds.
   * The cache is why `freshness` can honestly say `"cached"`.
   */
  const versionCache = new Map<string, string | undefined>()

  function versionOf(binary: string, configDir: string): string | undefined {
    const key = `${binary}\u0000${configDir}`
    if (versionCache.has(key)) return versionCache.get(key)
    // Spread of the ambient env, then `CLAUDE_CONFIG_DIR`. `HOME` is never
    // assigned here and must never be — see `claudeConfigDir` for the keychain
    // failure this prevents. A test asserts the probe env's `HOME` is the
    // ambient one.
    const probeEnv: NodeJS.ProcessEnv = { ...env, CLAUDE_CONFIG_DIR: configDir }
    const parsed = parseClaudeVersion(runVersion(binary, probeEnv))
    versionCache.set(key, parsed)
    return parsed
  }

  function resolveProfiles(): ResolvedProfile[] {
    const configured = Object.entries(options.providers ?? {}).filter(
      ([, instance]) => instance?.driver === "claude" && instance.enabled !== false,
    )

    if (configured.length === 0) {
      // The implicit profile. An install that never opened the provider editor
      // still has a Claude on `PATH` and a `~/.claude`, and reporting nothing
      // here would make the seat editor claim Claude is unavailable when it is
      // simply unconfigured.
      const profile: HostProfile = {
        id: CLAUDE_DEFAULT_PROFILE_ID,
        host: "claude" as HostKind,
        label: "Claude Code",
        binaryPath: CLAUDE_DEFAULT_BINARY,
        homePath: claudeConfigDir(env, home),
      }
      return [{ profile, binary: CLAUDE_DEFAULT_BINARY, customModels: [...pinned] }]
    }

    return configured.map(([id, instance]) => {
      const binary = instance.binaryPath ?? CLAUDE_DEFAULT_BINARY
      // An explicit `homePath` wins, then `CLAUDE_CONFIG_DIR`, then `~/.claude`.
      // The explicit one wins because that is the only way two profiles of the
      // same host stay separated on a machine where the env var is set
      // globally.
      const homePath = instance.homePath ?? claudeConfigDir(env, home)
      const profile: HostProfile = {
        id,
        host: "claude" as HostKind,
        label: instance.displayName ?? "Claude Code",
        binaryPath: binary,
        homePath,
      }
      return { profile, binary, customModels: [...pinned, ...profileCustomModels(instance)] }
    })
  }

  function findProfile(profileId: string): ResolvedProfile | undefined {
    return resolveProfiles().find((entry) => entry.profile.id === profileId)
  }

  /**
   * The models to offer for a profile. Never throws.
   *
   * `freshness` is always `"cached"` for the built-in entries, including the
   * ungated case: the list came off disk in this repository, not from the
   * host, and calling it `"live"` because a version probe succeeded would
   * overstate what was actually asked. `warnings` carries the rest of the
   * story — an unknown profile, an unreadable version — so the UI can say
   * why the list is what it is instead of showing a confident wrong one.
   */
  function buildCatalogue(profileId: string): ModelCatalogue {
    const warnings: string[] = []
    try {
      const resolved = findProfile(profileId)
      if (resolved === undefined) {
        warnings.push(
          `No Claude profile "${profileId}" is configured, so this list is not gated to an installed version. Models it does not have will be rejected by name.`,
        )
      }
      const binary = resolved?.binary ?? CLAUDE_DEFAULT_BINARY
      const configDir = resolved?.profile.homePath ?? claudeConfigDir(env, home)
      const version = versionOf(binary, configDir)

      if (version === undefined) {
        warnings.push(
          `Could not read a version from "${binary} --version", so this list is not gated to an installed version. Every known model is offered; the host has the final say.`,
        )
      }

      const models: CatalogueModel[] = []
      const seen = new Set<string>()
      for (const gate of CLAUDE_MODEL_GATES) {
        if (!availableAt(version, gate.since)) continue
        seen.add(gate.id)
        const model: CatalogueModel = {
          id: gate.id,
          label: gate.label,
          options: descriptorsFor(gate, version),
        }
        if (gate.contextWindow !== undefined) model.contextWindow = gate.contextWindow
        models.push(model)
      }

      /**
       * User-supplied ids, appended with no descriptors.
       *
       * No descriptors is the honest answer, not a gap. A Bedrock deployment
       * id or a private alias is a string this module has never seen; it
       * cannot know whether that deployment takes an effort, and inheriting
       * Opus's descriptors because the id contains "opus" would put a
       * thinking toggle or an `xhigh` level in front of a user whose
       * deployment rejects both. An empty `options` list renders as "no
       * options Observer can vouch for", and `diagnose` correspondingly
       * declines to warn about options set on an id it does not know.
       */
      for (const custom of resolved?.customModels ?? pinned) {
        const id = custom.trim()
        if (id.length === 0 || seen.has(id)) continue
        seen.add(id)
        models.push({ id, label: id, options: [] })
      }

      return {
        models,
        source:
          version === undefined
            ? `built-in Claude catalogue (no version from ${binary})`
            : `built-in Claude catalogue, gated at ${binary} ${version}`,
        freshness: "cached",
        warnings,
      }
    } catch {
      // Unreachable by design, and kept anyway: this is called from a TUI
      // render path, and the contract is a value, never an exception.
      return {
        models: [],
        source: "built-in Claude catalogue",
        freshness: "unknown",
        warnings: [...warnings, "The Claude model catalogue could not be built. Type a model below instead."],
      }
    }
  }

  return {
    kind: "claude" as HostKind,
    label: "Claude Code",

    profiles(): HostProfile[] {
      return resolveProfiles().map((entry) => entry.profile)
    },

    catalogue: buildCatalogue,

    diagnose(profileId: string, targetId: string, target: SeatTarget, employeeId: string): SeatIssue[] {
      try {
        return diagnoseClaudeTarget({
          target,
          targetId,
          employeeId,
          models: buildCatalogue(profileId).models,
        })
      } catch {
        // Same contract as `catalogue`: a config screen must never lose a
        // render to a finding it could not compute.
        return []
      }
    },

    capabilities(): HostCapabilities {
      return { ...CLAUDE_CAPABILITIES }
    },
  }
}

/**
 * The default adapter, reading the real environment.
 *
 * Constructed lazily by the caller rather than exported as a singleton: the
 * version cache is per instance, and a module-level singleton would hold a
 * probe result across a config change that repointed `binaryPath`.
 */
export function claudeAdapter(providers?: Record<string, ProviderInstanceConfig>): HostSeatAdapter {
  return createClaudeAdapter(providers === undefined ? {} : { providers })
}

/* -------------------------------------------------------------------------- */
/* Capabilities                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What Observer can and cannot do to a Claude seat today.
 *
 * `childModel` and `childReasoning` are `"unsupported"`, and that is a
 * statement about Observer, not about Claude. Claude's agent-definition
 * contract carries a per-subagent model, effort, prompt, tools, limits and
 * permission mode, and an Agent invocation can carry a model override on top.
 * The capability is real. Observer's *path to it* is not verified:
 *
 *  - `SubagentStart` fires after the child exists. It can add context; it
 *    cannot choose a model.
 *  - The current hook emitter cannot return `updatedInput`, so there is no way
 *    to rewrite an Agent call in flight.
 *  - Per-call effort is not a stable documented Agent input field.
 *
 * The future path, named so the next agent does not have to rediscover it:
 * generate marker-owned Claude agent definitions, one per employee per
 * profile, and redirect only a verified neutral/default Agent invocation from
 * a dedicated synchronous `PreToolUse` controller — copying the whole original
 * input and changing one field, leaving named specialised agents untouched.
 * When that is measured against real Claude Code versions, these two flags
 * become `"experimental"`, then `"supported"`. Not before: a seat UI reads
 * these flags to decide whether to tell a user their employee "runs Opus", and
 * that sentence is a claim about their bill.
 *
 * `requiresReload: true` because model and effort are read when a Claude
 * session starts; changing a seat cannot reach a session already running.
 */
export const CLAUDE_CAPABILITIES: HostCapabilities = {
  discovery: "cached",
  childModel: "unsupported",
  childReasoning: "unsupported",
  requiresReload: true,
}

/* -------------------------------------------------------------------------- */
/* Diagnosis                                                                  */
/* -------------------------------------------------------------------------- */

interface DiagnoseInput {
  target: SeatTarget
  targetId: string
  employeeId: string
  models: readonly CatalogueModel[]
}

/**
 * Findings for one Claude target. Pure, exported for its tests, throws nothing.
 *
 * The governing rule is that Claude model ids are host-native and this adapter
 * is not entitled to a syntax opinion about them. An id may be an alias
 * (`opus`), a full Anthropic id (`claude-opus-4-5`), or a provider deployment
 * id from Bedrock or Vertex
 * (`anthropic.claude-opus-4-5-v1:0`, `projects/p/locations/l/publishers/anthropic/models/m`).
 * None of those share a shape. In particular there is no `provider/model`
 * requirement here — that rule is OpenCode's addressing scheme, and applying
 * it to Claude would turn every correct alias into a config-blocking error.
 *
 * So the only rejection is an empty model. Everything else is a warning at
 * most, because the host is the authority and a warning the user can overrule
 * beats an error that blocks a config that would have worked.
 */
export function diagnoseClaudeTarget(input: DiagnoseInput): SeatIssue[] {
  const issues: SeatIssue[] = []
  const { target, targetId, employeeId } = input
  const path = `seats.employees.${employeeId}.targets.${targetId}`
  const host = typeof target?.host === "string" ? target.host : ""

  const add = (
    code: SeatIssue["code"],
    severity: SeatIssueSeverity,
    suffix: string,
    message: string,
  ): void => {
    issues.push({
      code,
      severity,
      path: suffix ? `${path}.${suffix}` : path,
      employeeId,
      targetId,
      host,
      message,
    })
  }

  // Defensive throughout: this runs on half-typed TUI input and on configs
  // written by other machines and other Observer versions.
  const rawModel = typeof target?.model === "string" ? target.model : undefined
  const model = rawModel?.trim()

  // The one error. A whitespace-only model is the same finding as an empty
  // one: it is a value that names nothing, and it is distinguishable from an
  // omitted model, which legitimately means "inherit the session's".
  if (rawModel !== undefined && (model === undefined || model.length === 0)) {
    add(
      "malformed-model",
      "error",
      "model",
      `This target sets an empty model. Claude accepts an alias like "opus", a full model id like "claude-opus-4-5", or a provider deployment id — or remove "model" to inherit the session's.`,
    )
  }

  const options: SeatTargetOption[] = Array.isArray(target?.options) ? target.options : []
  if (options.length === 0) return issues

  // `options-without-model` is host-agnostic and `diagnoseSeats` already
  // raises it. Repeating it here would double every such finding in a UI that
  // merges both sources.
  if (model === undefined || model.length === 0) return issues

  const known = input.models.find((entry) => entry.id === model)
  const declared = new Set((known?.options ?? []).map((descriptor) => descriptor.id))

  for (const option of options) {
    const id = typeof option?.id === "string" ? option.id : ""
    if (id.length === 0) continue
    const suffix = `options.${id}`

    if (!(CLAUDE_OPTION_IDS as readonly string[]).includes(id)) {
      add(
        "unknown-field",
        "info",
        suffix,
        `Observer does not apply "${id}" on Claude yet (it applies ${CLAUDE_OPTION_IDS.join(", ")}). It is preserved in the file untouched.`,
      )
      continue
    }

    /**
     * A model this catalogue has never heard of gets no option warnings at
     * all. `known === undefined` means a custom or deployment id, and the
     * whole reason those carry no descriptors is that their capabilities are
     * unknowable from here — so "this model does not declare `thinking`" would
     * be an assertion the adapter has no basis for. Silence, and let the host
     * rule. Same one-sided-safety rule as `models.ts`.
     */
    if (known !== undefined && !declared.has(id)) {
      add(
        "unknown-field",
        "warning",
        suffix,
        `"${model}" does not offer "${id}", so this option has no effect. ${
          declared.size === 0
            ? "This model exposes no options Observer can set."
            : `It offers: ${[...declared].join(", ")}.`
        }`,
      )
      continue
    }

    if (id === "effort") diagnoseEffort(option.value, known, add)
  }

  return issues
}

/**
 * The `effort` value's findings, reported through `add`.
 *
 * Split out because `ultrathink` needs its own sentence. Told only that the
 * value is unrecognised, a user reasonably concludes they misspelled a level
 * and tries again — the message has to say that the word is prompt text and
 * belongs in a message, not in this field, or they will keep setting it.
 */
function diagnoseEffort(
  value: unknown,
  known: CatalogueModel | undefined,
  add: (code: SeatIssue["code"], severity: SeatIssueSeverity, suffix: string, message: string) => void,
): void {
  const suffix = "options.effort"

  if (typeof value !== "string") {
    add(
      "unrecognised-variant",
      "warning",
      suffix,
      `"effort" takes a named level, not ${typeof value === "boolean" ? "a switch" : "this value"}. Set it to one of the levels the model offers, or drop it.`,
    )
    return
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) return

  if (PROMPT_ONLY_EFFORTS.has(trimmed.toLowerCase())) {
    add(
      "unrecognised-variant",
      "warning",
      suffix,
      `"${trimmed}" is prompt text, not a reasoning effort — Claude has no request field that accepts it, so Observer will not send it as "effort". Put it in a message, and set "effort" to a named level instead.`,
    )
    return
  }

  // An unknown model declares no choices, and a choice list we do not have is
  // not a choice list of zero. Warning here would flag a perfectly good
  // deployment-specific level.
  const choices = known?.options.find((descriptor) => descriptor.id === "effort")?.choices
  if (choices === undefined || choices.length === 0) return

  if (!choices.some((choice) => choice.id === trimmed)) {
    add(
      "unrecognised-variant",
      "warning",
      suffix,
      `"${trimmed}" is not an effort "${known?.id}" offers (${choices.map((choice) => choice.id).join(", ")}). It may still work — the host has the final say.`,
    )
  }
}

import type { HostKind } from "../providers.js"
import { claudeAdapter } from "./claude.js"
import { codexAdapter } from "./codex.js"
import { copilotAdapter } from "./copilot.js"
import { opencodeAdapter } from "./opencode.js"
import type { HostSeatAdapter } from "./types.js"

/**
 * How an adapter is built. Takes nothing, spawns nothing, and is called at
 * most once per process — see `instantiate`.
 *
 * A factory rather than the adapter itself because the three modules disagree
 * about what a "registry entry" is, for good reasons of their own: `opencode`
 * and `codex` export a singleton (`codexAdapter` is documented as spawning
 * nothing to construct), while `claude` deliberately exports a *function*
 * because its `claude --version` probe cache is per instance and a module-level
 * singleton would pin a probe result taken before the user installed anything.
 * Wrapping all three in `() => adapter` lets this file hold one uniform map and
 * lets each module keep its own lifetime rule.
 */
type AdapterFactory = () => HostSeatAdapter

/**
 * The host adapters Observer ships, keyed by the `HostKind` they claim.
 *
 * `Partial` and not `Record`, because the map is the honest answer to "which
 * hosts can Observer actually seat", and that is not all five. A total record
 * would force a placeholder for every host still unimplemented, and a
 * placeholder that answers `capabilities()` is indistinguishable from a real
 * adapter that reports `unsupported` — which is exactly the overclaim the
 * capability fields exist to prevent. An absent key means "no adapter has
 * claimed this host yet"; `unsupported` means "an adapter has looked and the
 * host cannot do it".
 *
 * Registration is one line per host, on purpose. Adapters are being written in
 * parallel and this file is the only place they meet — the whole entry is
 * `host: () => adapter`, and nothing else in this file, in `server.ts` or in
 * the REST surface has to change for a new one. `/v1/hosts` enumerates this
 * map, and a host that is not in it is a 404 rather than a special case.
 *
 * `cursor` and `grok` are the two `HOST_KINDS` still absent, and absent is the
 * correct entry for them until someone writes the adapter.
 *
 * Insertion order is the order `/v1/hosts` reports and therefore the order a
 * picker renders. OpenCode first because it has the established `supported`
 * control path.
 */
const ADAPTERS: Partial<Record<HostKind, AdapterFactory>> = {
  opencode: () => opencodeAdapter,
  codex: () => codexAdapter,
  claude: () => claudeAdapter(),
  copilot: () => copilotAdapter,
}

/**
 * One adapter instance per host, for the life of the process.
 *
 * Not an optimisation — a correctness and blast-radius decision. Every adapter
 * that touches a CLI memoises its probe *per instance* (`codex` caches the
 * `model/list` result with a TTL, `claude` caches `claude --version` per
 * binary), and a seat editor calls `catalogue()` on every keystroke. Handing
 * out a fresh instance per call would throw those caches away and turn one
 * bounded touch of the user's install into a subprocess per character.
 *
 * The cost is that a version probe taken now survives a `claude` upgrade made
 * later in the same daemon run. That is a slightly stale model list until the
 * daemon restarts, which is a far better failure than a spawn storm on a
 * config screen. A caller that needs a guaranteed-fresh, config-aware adapter
 * builds its own with `createClaudeAdapter({ providers })`.
 */
const INSTANCES = new Map<HostKind, HostSeatAdapter>()

/**
 * The instance for a host, building it on first use.
 *
 * A factory that throws yields `undefined` — the same answer as an unclaimed
 * host — rather than propagating. Construction reads `$HOME` and the
 * environment, and a container with neither should cost the settings page one
 * missing row, not a 500. The failure is deliberately not memoised: nothing
 * here spawns, so retrying next request is free and a transient environment
 * fix recovers without a restart.
 */
function instantiate(host: HostKind): HostSeatAdapter | undefined {
  const memo = INSTANCES.get(host)
  if (memo !== undefined) return memo
  const factory = ADAPTERS[host]
  if (factory === undefined) return undefined
  try {
    const adapter = factory()
    INSTANCES.set(host, adapter)
    return adapter
  } catch {
    return undefined
  }
}

/**
 * The adapter for a host, or undefined when nothing claims it.
 *
 * Takes `string` rather than `HostKind` because that is what a config actually
 * holds: `SeatTarget.host` stays a string so a user's typo survives the save
 * and is reported as `unknown-host` instead of being deleted. A caller that
 * had to narrow first would have to duplicate `isHostKind` at every call site
 * for no gain — an unrecognised host and a recognised-but-unclaimed one get
 * the same answer here, and it is the right one.
 *
 * Which is exactly why the lookup goes through `Object.hasOwn` rather than
 * plain indexing. The key comes from a hand-edited config file, and an object
 * literal inherits `Object.prototype`: `ADAPTERS["toString"]` is a function,
 * and returning it would hand a caller something that answers to `.kind` with
 * `undefined` and blows up on `.diagnose`. `host: "constructor"` is a typo, not
 * an adapter. Now that the map holds factories the guard matters more, not
 * less: an unguarded hit on `toString` would be *called*.
 */
export function seatAdapter(host: string): HostSeatAdapter | undefined {
  if (typeof host !== "string" || !Object.hasOwn(ADAPTERS, host)) return undefined
  return instantiate(host as HostKind)
}

/** Every registered adapter, in registration order, for a UI that enumerates hosts. */
export function seatAdapters(): HostSeatAdapter[] {
  return Object.keys(ADAPTERS)
    .map((host) => instantiate(host as HostKind))
    .filter((adapter): adapter is HostSeatAdapter => adapter !== undefined)
}

export type {
  CatalogueModel,
  ControlSupport,
  DiscoveryMode,
  HostCapabilities,
  HostProfile,
  HostSeatAdapter,
  ModelCatalogue,
  ModelOptionChoice,
  ModelOptionDescriptor,
} from "./types.js"
export {
  createOpencodeAdapter,
  opencodeAdapter,
  readOpencodeTarget,
  OPENCODE_DEFAULT_PROFILE,
  OPENCODE_VARIANT_OPTION,
} from "./opencode.js"
export type { OpencodeAdapterOptions, OpencodeSeatTarget } from "./opencode.js"
export { createCodexAdapter, codexAdapter, CODEX_DEFAULT_PROFILE } from "./codex.js"
export type { CodexAdapterOptions, CodexSpawn, CodexSpawnResult } from "./codex.js"
export { createClaudeAdapter, claudeAdapter, CLAUDE_DEFAULT_PROFILE_ID } from "./claude.js"
export type { ClaudeAdapterOptions, ClaudeVersionRunner } from "./claude.js"
export {
  createCopilotAdapter,
  copilotAdapter,
  copilotSeatAgentName,
  copilotSeatAgentReference,
  readCopilotTarget,
  COPILOT_SEAT_AGENT_MARKER,
  COPILOT_DEFAULT_PROFILE,
} from "./copilot.js"
export type { CopilotAdapterOptions, CopilotSeatTarget, CopilotSpawn, CopilotSpawnResult } from "./copilot.js"

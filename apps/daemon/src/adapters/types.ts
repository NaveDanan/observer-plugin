import type { HostKind } from "../providers.js"
import type { SeatIssue, SeatTarget } from "../seats.js"

/**
 * The contract every host adapter implements, and the only place a host's own
 * vocabulary is allowed to be understood.
 *
 * Above this line a seat target is opaque: `seats.ts` deliberately does not
 * parse a `model`, does not know what an option id means, and does not decide
 * whether `provider/model` is the right shape for an id — because it is right
 * for OpenCode and wrong for Codex's `gpt-5.6-sol`. Below this line an adapter
 * knows exactly one host and is entitled to all of it.
 *
 * Two things the interface refuses to conflate, because the spec's capability
 * table turns on the difference:
 *
 *  - **Discovery** is "can Observer list what this host can run". Every host
 *    can do some version of this.
 *  - **Control** is "can Observer make a delegated child run a chosen model".
 *    OpenCode and Copilot support this through narrow neutral-agent paths. A
 *    UI that promotes discovery into control would tell the user their Cursor
 *    employee runs Opus when it demonstrably does not, so `HostCapabilities`
 *    reports them separately and no adapter may collapse them.
 *
 * Everything here is synchronous. The catalogue is a file read and the
 * diagnosis is arithmetic over it; making the interface async would push a
 * promise through `syncSeatAgents`, the installer and the TUI's render path for
 * no gain, and the one source that genuinely costs seconds (`opencode models
 * --verbose`) is already opt-in behind `listModels({ probeHost: true })`.
 */

/**
 * Where a host's model inventory comes from.
 *
 *  - `live`   — asked the host or its API this run.
 *  - `cached` — read from a snapshot the host maintains on disk.
 *  - `manual` — nothing is discoverable; the user types an id.
 */
export type DiscoveryMode = "live" | "cached" | "manual"

/**
 * How far Observer will go in acting on a setting for this host.
 *
 * `experimental` is a real third state and not a hedge: Codex's per-child model
 * needs a synchronous `PreToolUse` rewrite that has been prototyped and not
 * hardened, and shipping it as `supported` would have the TUI promise something
 * that fails open. A UI must render the three differently.
 */
export type ControlSupport = "supported" | "experimental" | "unsupported"

/**
 * One configured install of a host.
 *
 * `id` is the instance key seat targets are filed under (`opencode:default`,
 * `codex:work`), so a target and the profile that serves it can be joined
 * without guessing. `binaryPath` and `homePath` mirror
 * `ProviderInstanceConfig`: they are the only two things that distinguish two
 * profiles of the same host, and both are absent when the host's own defaults
 * apply.
 */
export interface HostProfile {
  id: string
  host: HostKind
  label: string
  binaryPath?: string
  homePath?: string
}

export interface ModelOptionChoice {
  id: string
  label: string
  isDefault?: boolean
}

/**
 * One knob a host exposes for a model, described well enough for a UI to
 * render it without knowing which host it came from.
 *
 * `id` is the host's own name for the knob (`variant`, `reasoningEffort`), and
 * it is the same id `SeatTargetOption.id` stores, so a value round-trips
 * through the config untranslated.
 */
export interface ModelOptionDescriptor {
  id: string
  label: string
  type: "select" | "boolean"
  choices?: ModelOptionChoice[]
  currentValue?: string | boolean
}

export interface CatalogueModel {
  id: string
  label: string
  contextWindow?: number
  /**
   * False when the host lists the model but this account may not run it.
   *
   * Three states on purpose, and `undefined` is the important one: it means
   * nobody asked, not that the model is confirmed usable. A host with no way to
   * report entitlement leaves it absent and every model renders normally, which
   * is what every host except Copilot does today. Only an explicit `false` may
   * grey a row out, so a failed or unsupported check can never disable a list.
   */
  available?: boolean
  options: ModelOptionDescriptor[]
}

/**
 * What a host can run, plus an honest account of where the answer came from.
 *
 * `source` and `freshness` are not decoration. An empty `models` list is a
 * supported state — the user types an id by hand — and the difference between
 * "this host has no models" and "we could not read the snapshot" is the
 * difference between a UI that explains itself and one that looks broken.
 * `warnings` carries that sentence, ready to render verbatim.
 */
export interface ModelCatalogue {
  models: CatalogueModel[]
  source: string
  freshness: "live" | "cached" | "unknown"
  warnings: string[]
}

export interface HostCapabilities {
  discovery: DiscoveryMode
  childModel: ControlSupport
  childReasoning: ControlSupport
  /**
   * Whether a configuration change only takes effect after the host restarts.
   * True for OpenCode, which reads agent definitions once at startup.
   */
  requiresReload: boolean
}

export interface HostSeatAdapter {
  kind: HostKind
  label: string
  profiles(): HostProfile[]
  catalogue(profileId: string): ModelCatalogue
  /**
   * Everything this host knows to be wrong with one target, and nothing that
   * is true of every host — `diagnoseSeats` already owns the shared rules and
   * saying them twice would put two rows in the TUI for one mistake.
   *
   * `employeeId` and `targetId` come in rather than out because the adapter
   * has to stamp them onto every `SeatIssue` it returns: a finding a UI cannot
   * put on a row is a finding the user cannot act on.
   */
  diagnose(profileId: string, targetId: string, target: SeatTarget, employeeId: string): SeatIssue[]
  capabilities(profileId: string): HostCapabilities
}

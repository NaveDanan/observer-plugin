import type {
  AgentDetail,
  Change,
  HostCapabilities,
  SessionEntity,
  SessionSnapshot,
  StoredEvent,
} from "@observer-ai/protocol"
import type { RosterProfile } from "@observer-ai/roster"

export interface Bootstrap {
  token: string
  cursor: number
  protocol: number
  hosts: HostCapabilities[]
  capture: Record<string, boolean>
  retentionDays: number
  redaction: { enabled: boolean; maxTextLength: number }
}

let token = ""

export function setToken(value: string): void {
  token = value
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status}`)
  return (await response.json()) as T
}

export async function bootstrap(): Promise<Bootstrap> {
  const result = await request<Bootstrap>("/v1/bootstrap")
  setToken(result.token)
  return result
}

export function listSessions(): Promise<{ sessions: SessionEntity[] }> {
  return request("/v1/sessions?limit=50")
}

export function getSnapshot(sessionId: string): Promise<SessionSnapshot> {
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}`)
}

export function getAgentDetail(agentId: string): Promise<AgentDetail> {
  return request(`/v1/agents/${encodeURIComponent(agentId)}`)
}

export function getRoster(): Promise<{ profiles: RosterProfile[] }> {
  return request("/v1/roster")
}

export function getRawEvents(sessionId: string): Promise<{ events: StoredEvent[] }> {
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}/events`)
}

export function deleteSession(sessionId: string): Promise<{ ok: boolean }> {
  return request(`/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
}

export interface DeliveryDiagnostics {
  accepted: number
  counters: Record<string, number>
  faults: number
  lastAcceptedByHost: Record<string, number>
  recent: Array<{ at: number; host: string; event: string; reason: string; detail?: string; payloadKeys: string[] }>
}

export function getDiagnostics(): Promise<DeliveryDiagnostics> {
  return request("/v1/diagnostics")
}

/* ---------------------------------------------------------------- settings */

/**
 * The daemon's config, as the settings surfaces see it.
 *
 * These types mirror `apps/daemon/src/config.ts` rather than importing them:
 * the daemon package pulls in fastify and node builtins, and the browser needs
 * the shapes, not the code. The daemon is the authority — every one of these
 * fields is re-validated there before it reaches disk.
 */
export interface CaptureConfig {
  messages: boolean
  reasoning: boolean
  toolInput: boolean
  toolOutput: boolean
  prompts: boolean
  rawEvents: boolean
}

export interface SeatSkill {
  name: string
  description: string
}

/**
 * One knob on a host, under the host's own name for it.
 *
 * `string | boolean` and no third case, exactly as `SeatTargetOption` in
 * `apps/daemon/src/seats.ts` has it: every option the five hosts expose today
 * is either a named level (`"high"`, `"adaptive"`) or a switch. The index
 * signature is not decoration — the daemon's schema keeps unknown keys on
 * purpose, and a settings surface that round-trips a target must hand them
 * back untouched.
 */
export interface SeatTargetOption {
  id: string
  value: string | boolean
  [extra: string]: unknown
}

/**
 * What an employee should run on one host.
 *
 * `host` is a `string` and not a union for the reason the daemon gives: a
 * typo must survive the save and be reported as `unknown-host`, not deleted
 * out from under the user. `model` is **opaque** — nothing in the browser
 * parses it, because `provider/model` is OpenCode's addressing scheme and
 * Codex's `gpt-5.6-sol` is exactly right as written.
 */
export interface SeatTarget {
  host: string
  model?: string
  options?: SeatTargetOption[]
  [extra: string]: unknown
}

/** One employee's desired per-host configuration and skills. */
export interface SeatSpec {
  /** Legacy OpenCode model. Read through `readTargets`, never directly. */
  model?: string
  /** Legacy OpenCode reasoning effort. Read through `readTargets`. */
  variant?: string
  skills?: SeatSkill[]
  /**
   * Per-host configuration, keyed by provider instance id
   * (`opencode:default`, `codex:work`).
   *
   * Absent — not empty — is what every config written before targets landed
   * has, and it is the signal that the legacy `model`/`variant` pair still
   * applies. An explicit `{}` means "configured for no host", which is a
   * different statement.
   */
  targets?: Record<string, SeatTarget>
  [extra: string]: unknown
}

export interface SeatsConfig {
  control: boolean
  employees: Record<string, SeatSpec>
}

export type SeatIssueSeverity = "error" | "warning" | "info"

export interface SeatIssue {
  code: string
  severity: SeatIssueSeverity
  path: string
  employeeId?: string
  /**
   * The target key the finding is scoped to, e.g. `codex:default`.
   *
   * Present so a row can be found without re-parsing `path` — target keys
   * contain `:` and may contain `.`, so splitting the path back apart is not
   * safe, which is precisely why the daemon sends this field.
   */
  targetId?: string
  /** The host that target names, verbatim, including an unrecognised one. */
  host?: string
  message: string
}

export interface SeatDiagnosis {
  ok: boolean
  effective: boolean
  issues: SeatIssue[]
}

/** A provider the plugin has access to. `driver` names the host adapter. */
export interface ProviderInstanceConfig {
  driver: string
  displayName?: string
  accentColor?: string
  enabled: boolean
}

export interface ObserverConfigView {
  capture: CaptureConfig
  retentionDays: number
  redaction: { enabled: boolean; maxTextLength: number }
  guidance: boolean
  seats: SeatsConfig
  providers: Record<string, ProviderInstanceConfig>
  diagnosis: SeatDiagnosis
}

export type ConfigPatch = Partial<Omit<ObserverConfigView, "diagnosis">>

export function getConfig(): Promise<ObserverConfigView> {
  return request("/v1/config")
}

export function updateConfig(patch: ConfigPatch): Promise<ObserverConfigView> {
  return request("/v1/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
}

/**
 * What Observer knows about a model's reasoning efforts. Three states, never
 * two: "takes no effort" and "we could not tell" are different answers.
 */
export type ModelVariants = { kind: "efforts"; values: string[] } | { kind: "none" } | { kind: "unknown" }

export interface ModelInfo {
  /** `providerID/modelID`, exactly as a seat spec stores it. */
  id: string
  provider: string
  providerLabel: string
  label: string
  contextWindow?: number
  variants: ModelVariants
  releaseDate?: string
  known: boolean
}

export interface ModelCatalogue {
  count: number
  models: ModelInfo[]
  sources?: Record<string, unknown>
}

export function getModels(probe = false): Promise<ModelCatalogue> {
  return request(`/v1/models?probe=${probe ? "true" : "false"}`)
}

export interface ProviderHostStatus {
  id: string
  label: string
  notes: string[]
  sessions: number
  lastActiveAt: number | null
  configured: boolean
  enabledInstances: number
}

export function getProviderStatus(): Promise<{ hosts: ProviderHostStatus[] }> {
  return request("/v1/providers/status")
}

/* ------------------------------------------------------------------- hosts */

/**
 * The seat-configuration view of a host, from `GET /v1/hosts` and
 * `GET /v1/hosts/:host/models`.
 *
 * Distinct from `Bootstrap.hosts`, which is the protocol package's
 * `HostCapabilities` and answers "what telemetry does this host send us". These
 * answer "what can Observer configure on this host, and how honestly" — which
 * is why the name here is `SeatHostCapabilities`, matching the daemon's own
 * alias rather than shadowing the protocol type.
 *
 * Nothing in this section is derived, guessed or padded in the browser. The
 * daemon owns every one of these fields, and until recently the browser kept a
 * mirror of them because no endpoint served them. It does now, and the mirror
 * is gone.
 */

export type DiscoveryMode = "live" | "cached" | "manual"

/**
 * How far Observer will go in acting on a setting for this host.
 *
 * `experimental` is a real third state and not a hedge: Codex's per-child model
 * needs a synchronous `PreToolUse` rewrite that is prototyped and not hardened.
 * The three must render differently.
 */
export type ControlSupport = "supported" | "experimental" | "unsupported"

export interface SeatHostCapabilities {
  discovery: DiscoveryMode
  childModel: ControlSupport
  childReasoning: ControlSupport
  /** True where a change lands only after the host restarts. */
  requiresReload: boolean
}

/**
 * One configured install of a host.
 *
 * `id` is the instance key seat targets are filed under (`opencode:default`,
 * `codex:work`). `binaryPath` and `homePath` are omitted when the host's own
 * defaults apply, and they are the only two things that distinguish two
 * profiles of the same host.
 */
export interface HostProfileInfo {
  id: string
  host: string
  label: string
  binaryPath?: string
  homePath?: string
}

export interface HostSummary {
  id: string
  label: string
  profiles: HostProfileInfo[]
  /**
   * **Nullable, and the null is load-bearing.**
   *
   * `null` means no adapter could answer — it threw, and the daemon contained
   * it. That is not the same fact as `childModel: "unsupported"`, which means
   * an adapter looked and the host cannot do it. Only the second is a finding.
   * A UI that rendered null as "no control" would forge a capability check
   * nobody performed, so `status.ts` renders it as an explicit unknown.
   */
  capabilities: SeatHostCapabilities | null
  /** The daemon's own sentences about a degraded answer. Render verbatim. */
  warnings: string[]
}

export function getHosts(): Promise<{ hosts: HostSummary[] }> {
  return request("/v1/hosts")
}

export interface ModelOptionChoice {
  id: string
  label: string
  isDefault?: boolean
}

/**
 * One knob a host exposes for a model, described well enough for a UI to render
 * it without knowing which host it came from.
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

export interface HostCatalogueModel {
  id: string
  label: string
  contextWindow?: number
  /** `[]` means "no knobs Observer can vouch for", not "an empty dropdown". */
  options: ModelOptionDescriptor[]
}

/** Where the list came from. The server's vocabulary, adopted verbatim. */
export type CatalogueFreshness = "live" | "cached" | "unknown"

export interface HostCatalogue {
  host: string
  label: string
  /** The profile actually answered for, so a picker that sent none learns which. */
  profile: string
  models: HostCatalogueModel[]
  source: string
  freshness: CatalogueFreshness
  warnings: string[]
}

/**
 * One host's catalogue. **This can spawn a subprocess and cost seconds**, which
 * is why it is never called on tab open — only once a target is expanded.
 *
 * An unregistered host is a 404 and throws. A registered host whose binary is
 * absent is a 200 with `models: []`, `freshness: "unknown"` and a warning: a
 * normal state on a machine with only one of these tools installed, and not an
 * error to render as one.
 */
export function getHostModels(host: string, profile?: string): Promise<HostCatalogue> {
  const query = profile !== undefined && profile.length > 0 ? `?profile=${encodeURIComponent(profile)}` : ""
  return request(`/v1/hosts/${encodeURIComponent(host)}/models${query}`)
}

export function streamUrl(cursor: number): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/v1/stream?token=${encodeURIComponent(token)}&cursor=${cursor}`
}

export type { Change }

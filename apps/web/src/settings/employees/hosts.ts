/**
 * The two host endpoints, and the very different costs of calling them.
 *
 * `GET /v1/hosts` is spawn-free by construction — the daemon calls only
 * `profiles()` and `capabilities()`, and has a test asserting the catalogue
 * counter stays at zero. So it is fetched once, eagerly, when the Employees tab
 * mounts. Every host row, every profile and every control status comes from it.
 *
 * `GET /v1/hosts/:host/models` **can start a process**. Codex spawns
 * `codex app-server` and follows a cursor across pages; Claude shells out for
 * `--version`. On a laptop with only one of these tools installed, the others
 * cost their whole timeout budget before answering "not here". So it is fetched
 * lazily, per host *and* profile, only once the user expands the target that
 * needs it — never on tab open, and never for the four targets they did not
 * open.
 *
 * Both stores are module-level, for the reason `useConfig` keeps one: the panel
 * unmounts on every visit to Appearance and neither answer changes while you
 * are away. The catalogue cache is keyed by `host|profile` and survives the
 * dialog closing, so reopening an employee costs nothing — with an explicit
 * `refresh` for the rescan button, which is the one time re-spawning is what
 * the user asked for.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react"
import * as api from "../../api"
import type { HostCatalogue, HostSummary } from "../../api"

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* --------------------------------------------------------------- host list */

/**
 * The host list, plus why it is not here yet.
 *
 * `loading` and `error` are separate from an empty `hosts` array on purpose.
 * "We have not asked yet", "the daemon did not answer" and "the daemon answered
 * with no hosts" are three different things to tell a user, and a surface that
 * collapsed them would render "no adapter claims this host" over a request that
 * simply had not returned.
 */
export interface HostDirectory {
  hosts: HostSummary[]
  loading: boolean
  error: string | undefined
  /** True once a response has been adopted, successfully or not. */
  settled: boolean
}

let directory: HostDirectory = { hosts: [], loading: true, error: undefined, settled: false }
let directoryListeners: Array<() => void> = []
let directoryLoaded = false
let directoryInflight: Promise<void> | null = null

function setDirectory(patch: Partial<HostDirectory>): void {
  directory = { ...directory, ...patch }
  for (const listener of directoryListeners) listener()
}

function subscribeDirectory(listener: () => void): () => void {
  directoryListeners.push(listener)
  return () => {
    directoryListeners = directoryListeners.filter((entry) => entry !== listener)
  }
}

/** The directory as it stands, readable without React. */
export function hostDirectorySnapshot(): HostDirectory {
  return directory
}

/**
 * Fetches the host list, at most once unless forced.
 *
 * Exported alongside the hook so the store can be driven by a test without a
 * renderer — the caching, de-duplication and failure behaviour below are the
 * parts worth pinning down, and they have nothing to do with React.
 */
export async function loadHostDirectory(force = false): Promise<void> {
  if (directoryInflight) return directoryInflight
  if (directoryLoaded && !force) return
  setDirectory({ loading: true })
  directoryInflight = (async () => {
    try {
      const response = await api.getHosts()
      setDirectory({ hosts: response.hosts, error: undefined })
    } catch (error) {
      // The list is kept rather than emptied: a failed refresh should not blank
      // a directory that was answering a moment ago.
      setDirectory({ error: message(error) })
    } finally {
      directoryLoaded = true
      setDirectory({ loading: false, settled: true })
      directoryInflight = null
    }
  })()
  return directoryInflight
}

export function useHostDirectory(): HostDirectory & { reload: () => Promise<void> } {
  const snapshot = useSyncExternalStore(
    subscribeDirectory,
    () => directory,
    () => directory,
  )
  useEffect(() => {
    void loadHostDirectory()
  }, [])
  const reload = useCallback(() => loadHostDirectory(true), [])
  return { ...snapshot, reload }
}

/* --------------------------------------------------------------- catalogue */

/**
 * One host catalogue request, as a state machine rather than three booleans.
 *
 * A discriminated union because the four states carry different data and a
 * component that can only reach `catalogue` through `status === "ready"` cannot
 * accidentally render a stale list under a spinner.
 */
export type CatalogueState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; catalogue: HostCatalogue }

const IDLE: CatalogueState = { status: "idle" }

/**
 * Keyed by `host|profile` and not by host alone.
 *
 * A two-account Codex user gets a different list per profile, and the endpoint
 * echoes back which profile it answered for precisely so a picker can tell them
 * apart. Sharing one cache slot would show the work account's models under the
 * personal one.
 */
const catalogues = new Map<string, CatalogueState>()
const catalogueInflight = new Map<string, Promise<void>>()
let catalogueListeners: Array<() => void> = []

function catalogueKey(host: string, profile: string | undefined): string {
  return `${host}|${profile ?? ""}`
}

function notifyCatalogues(): void {
  for (const listener of catalogueListeners) listener()
}

function subscribeCatalogues(listener: () => void): () => void {
  catalogueListeners.push(listener)
  return () => {
    catalogueListeners = catalogueListeners.filter((entry) => entry !== listener)
  }
}

/** One host and profile's catalogue state, readable without React. */
export function hostCatalogueSnapshot(host: string, profile: string | undefined): CatalogueState {
  return catalogues.get(catalogueKey(host, profile)) ?? IDLE
}

/**
 * Fetches one host's catalogue, at most once per `host|profile` unless forced.
 *
 * **This is the call that can start a process.** Everything about when it runs
 * is a product decision, so it is exported and tested directly rather than only
 * through the hook.
 */
export async function loadHostCatalogue(
  host: string,
  profile: string | undefined,
  force = false,
): Promise<void> {
  const key = catalogueKey(host, profile)
  const inflight = catalogueInflight.get(key)
  if (inflight) return inflight
  if (!force && catalogues.get(key)?.status === "ready") return
  catalogues.set(key, { status: "loading" })
  notifyCatalogues()

  const work = (async () => {
    try {
      const catalogue = await api.getHostModels(host, profile)
      catalogues.set(key, { status: "ready", catalogue })
    } catch (error) {
      // A 404 lands here, and so does a daemon that is not answering. Both are
      // the browser's problem to explain; a host whose *binary* is missing is
      // not — that comes back as a healthy 200 with a warning and no models.
      catalogues.set(key, { status: "error", error: message(error) })
    } finally {
      catalogueInflight.delete(key)
      notifyCatalogues()
    }
  })()
  catalogueInflight.set(key, work)
  return work
}

/**
 * The catalogue for one host and profile, fetched on mount.
 *
 * Mounting is the trigger because mounting is the user's own action: this hook
 * lives in the target card, and a target card only renders once its row has
 * been expanded. `host` empty means the target names no host at all, and the
 * hook stays idle rather than issuing `/v1/hosts//models`.
 */
export function useHostCatalogue(
  host: string,
  profile: string | undefined,
): CatalogueState & { refresh: () => Promise<void> } {
  const key = catalogueKey(host, profile)
  const snapshot = useSyncExternalStore(
    subscribeCatalogues,
    () => catalogues.get(key) ?? IDLE,
    () => catalogues.get(key) ?? IDLE,
  )

  useEffect(() => {
    if (host.length === 0) return
    void loadHostCatalogue(host, profile, false)
  }, [host, profile])

  const refresh = useCallback(() => {
    if (host.length === 0) return Promise.resolve()
    return loadHostCatalogue(host, profile, true)
  }, [host, profile])

  return { ...snapshot, refresh }
}

/**
 * Drops every cached catalogue. Exported for tests, which must not inherit one
 * another's answers, and for nothing else — the UI has `refresh`.
 */
export function resetHostCaches(): void {
  catalogues.clear()
  catalogueInflight.clear()
  directory = { hosts: [], loading: true, error: undefined, settled: false }
  directoryLoaded = false
  directoryInflight = null
  notifyCatalogues()
  for (const listener of directoryListeners) listener()
}

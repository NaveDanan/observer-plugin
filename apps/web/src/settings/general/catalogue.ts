/**
 * The roster and the model catalogue behind the Employees section.
 *
 * One module-level copy for the same reason `useConfig` keeps one: the panel
 * unmounts every time you visit Appearance and neither answer changes while
 * you are away, so a per-component fetch would spend two requests to learn
 * what it already knew. Neither list is editable here, so there is no write
 * path to keep honest — only `refreshModels`, which is a deliberate rescan.
 *
 * The two requests fail independently. A roster that does not load leaves the
 * grid with nothing to draw and is fatal to the section; an empty catalogue is
 * a supported state the daemon documents (`listModels` returns `[]` on a
 * machine that has never run OpenCode), so it is reported to the picker rather
 * than treated as an error.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react"
import type { RosterProfile } from "@observer-ai/roster"
import * as api from "../../api"
import type { ModelInfo } from "../../api"

interface CatalogueState {
  profiles: RosterProfile[]
  models: ModelInfo[]
  loading: boolean
  /** The roster request's failure. The grid cannot be drawn without it. */
  rosterError: string | undefined
  /** The models request's failure, which is not the same as an empty list. */
  modelsError: string | undefined
  /** A `?probe=true` rescan is running: it shells out and costs seconds. */
  probing: boolean
}

let state: CatalogueState = {
  profiles: [],
  models: [],
  // True before the first `load` runs, so the grid renders "loading" rather
  // than "nobody matches that" in the frame between mount and effect.
  loading: true,
  rosterError: undefined,
  modelsError: undefined,
  probing: false,
}
let listeners: Array<() => void> = []
let loaded = false
let inflight: Promise<void> | null = null

function set(patch: Partial<CatalogueState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((entry) => entry !== listener)
  }
}

function getSnapshot(): CatalogueState {
  return state
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function load(): Promise<void> {
  if (inflight) return inflight
  if (loaded) return
  set({ loading: true })
  inflight = (async () => {
    // Settled rather than awaited in sequence: a roster outage must not also
    // cost the model list, since the picker is useful with either one alone.
    const [roster, models] = await Promise.allSettled([api.getRoster(), api.getModels(false)])
    set({
      profiles: roster.status === "fulfilled" ? roster.value.profiles : [],
      rosterError: roster.status === "fulfilled" ? undefined : message(roster.reason),
      models: models.status === "fulfilled" ? models.value.models : [],
      modelsError: models.status === "fulfilled" ? undefined : message(models.reason),
      loading: false,
    })
    loaded = true
    inflight = null
  })()
  return inflight
}

/**
 * Re-reads the catalogue with the host probe on.
 *
 * The probe is opt-in here exactly as it is in `observer config`: it runs
 * `opencode models` and costs seconds, which is the wrong price to pay on
 * every mount but the right one when a user has just installed a provider and
 * is standing in front of the picker wondering where it is.
 */
async function refresh(): Promise<void> {
  set({ probing: true })
  try {
    const models = await api.getModels(true)
    set({ models: models.models, modelsError: undefined })
  } catch (error) {
    set({ modelsError: message(error) })
  } finally {
    set({ probing: false })
  }
}

export function useCatalogue(): CatalogueState & { refreshModels: () => Promise<void> } {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    void load()
  }, [])
  const refreshModels = useCallback(() => refresh(), [])
  return { ...snapshot, refreshModels }
}

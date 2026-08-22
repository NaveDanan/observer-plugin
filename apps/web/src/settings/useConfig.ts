/**
 * The daemon config, shared by every settings surface.
 *
 * One module-level copy, not one per panel: General and Providers edit the
 * same file, and two components holding two snapshots of it is how a save
 * from one tab quietly reverts a change made in the other. Writes are
 * optimistic — the control moves immediately — and the daemon's response is
 * authoritative, so a rejected patch snaps back.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react"
import * as api from "../api"
import type { ConfigPatch, ObserverConfigView } from "../api"

interface ConfigState {
  config: ObserverConfigView | undefined
  loading: boolean
  /** The last write or read failure, cleared by the next success. */
  error: string | undefined
  saving: boolean
}

let state: ConfigState = { config: undefined, loading: false, error: undefined, saving: false }
let listeners: Array<() => void> = []
let inflight: Promise<void> | null = null

function set(patch: Partial<ConfigState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((entry) => entry !== listener)
  }
}

function getSnapshot(): ConfigState {
  return state
}

export async function loadConfig(force = false): Promise<void> {
  if (inflight) return inflight
  if (state.config && !force) return
  set({ loading: true })
  inflight = (async () => {
    try {
      const config = await api.getConfig()
      set({ config, error: undefined })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ loading: false })
      inflight = null
    }
  })()
  return inflight
}

/**
 * Sends a patch and adopts the daemon's answer.
 *
 * The local copy moves first so a switch does not lag a round trip, and the
 * response replaces it wholesale: the daemon may normalise what it was sent
 * (a bare skill name becomes `{name, description}`), and the UI should show
 * what is actually on disk rather than what it asked for.
 */
export async function saveConfig(patch: ConfigPatch): Promise<boolean> {
  const previous = state.config
  if (previous) set({ config: { ...previous, ...patch } as ObserverConfigView })
  set({ saving: true })
  try {
    const config = await api.updateConfig(patch)
    set({ config, error: undefined })
    return true
  } catch (error) {
    set({ config: previous, error: error instanceof Error ? error.message : String(error) })
    return false
  } finally {
    set({ saving: false })
  }
}

export function useObserverConfig(): ConfigState & {
  save: (patch: ConfigPatch) => Promise<boolean>
  reload: () => Promise<void>
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => {
    void loadConfig()
  }, [])
  const save = useCallback((patch: ConfigPatch) => saveConfig(patch), [])
  const reload = useCallback(() => loadConfig(true), [])
  return { ...snapshot, save, reload }
}

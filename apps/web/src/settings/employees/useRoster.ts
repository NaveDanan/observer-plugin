/**
 * The roster behind the Employees tab.
 *
 * One module-level copy for the same reason `useConfig` keeps one: the panel
 * unmounts every time you visit Appearance and the roster does not change while
 * you are away, so a per-component fetch would spend a request to learn what it
 * already knew. Nothing here is editable, so there is no write path to keep
 * honest.
 *
 * This used to fetch the OpenCode model catalogue too, from `GET /v1/models`.
 * It does not any more: `GET /v1/hosts/:host/models` serves every host's list
 * including OpenCode's, and it is fetched lazily per target rather than eagerly
 * on mount — see `hosts.ts`. A roster that does not load is fatal to the tab;
 * that is the one failure this module has to report.
 */

import { useEffect, useSyncExternalStore } from "react"
import type { RosterProfile } from "@observer-ai/roster"
import * as api from "../../api"

interface RosterState {
  profiles: RosterProfile[]
  loading: boolean
  /** The roster request's failure. The list cannot be drawn without it. */
  error: string | undefined
}

let state: RosterState = {
  profiles: [],
  // True before the first `load` runs, so the list renders "loading" rather
  // than "nobody matches that" in the frame between mount and effect.
  loading: true,
  error: undefined,
}
let listeners: Array<() => void> = []
let loaded = false
let inflight: Promise<void> | null = null

function set(patch: Partial<RosterState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((entry) => entry !== listener)
  }
}

async function load(): Promise<void> {
  if (inflight) return inflight
  if (loaded) return
  set({ loading: true })
  inflight = (async () => {
    try {
      const response = await api.getRoster()
      set({ profiles: response.profiles, error: undefined })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      loaded = true
      set({ loading: false })
      inflight = null
    }
  })()
  return inflight
}

export function useRoster(): RosterState {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
  useEffect(() => {
    void load()
  }, [])
  return snapshot
}

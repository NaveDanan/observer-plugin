import type { SeatsConfig } from "@observer-ai/daemon"
import { syncCopilotSeatAgents } from "./copilot-seat-agents.js"
import { syncSeatAgents } from "./seat-agents.js"

export interface SeatControlSync {
  written: string[]
  removed: string[]
  notes: string[]
}

/** Reconciles every host-specific artifact derived from the seat configuration. */
export function syncSeatControl(seats: SeatsConfig): SeatControlSync {
  const opencode = syncSeatAgents(seats)
  const copilot = syncCopilotSeatAgents(seats)
  return {
    written: [...opencode.written, ...copilot.written],
    removed: [...opencode.removed, ...copilot.removed],
    notes: [...opencode.notes, ...copilot.notes],
  }
}

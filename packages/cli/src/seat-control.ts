import type { SeatsConfig } from "@observer-ai/daemon"
import { syncCopilotSeatAgents } from "./copilot-seat-agents.js"
import { syncClaudeEmployeeAgents, syncCodexEmployeeAgents } from "./host-employee-agents.js"
import { syncSeatAgents } from "./seat-agents.js"

export interface SeatControlSync {
  written: string[]
  removed: string[]
  notes: string[]
}

export interface SeatControlSyncOptions {
  passAllSkills?: boolean
}

/** Reconciles every host-specific artifact derived from the seat configuration. */
export function syncSeatControl(seats: SeatsConfig, options: SeatControlSyncOptions = {}): SeatControlSync {
  const opencode = syncSeatAgents(seats)
  const copilot = syncCopilotSeatAgents(seats)
  const codex = syncCodexEmployeeAgents(seats, { passAllSkills: options.passAllSkills })
  const claude = syncClaudeEmployeeAgents(seats)
  return {
    written: [...opencode.written, ...copilot.written, ...codex.written, ...claude.written],
    removed: [...opencode.removed, ...copilot.removed, ...codex.removed, ...claude.removed],
    notes: [...opencode.notes, ...copilot.notes, ...codex.notes, ...claude.notes],
  }
}

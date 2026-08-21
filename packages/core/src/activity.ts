import type { ToolCallEntity } from "@observer-ai/protocol"

/**
 * Pure selector for current activity.
 *
 * Returns the tool call currently running for an agent, plus elapsed time,
 * or undefined when idle. Elapsed is derived from startedAt and a supplied
 * now, so the function stays pure and clock-independent and is testable
 * without a browser or DOM.
 */
export interface CurrentActivity {
  tool: ToolCallEntity
  elapsedMs: number
}

export function currentActivity(
  toolCalls: ToolCallEntity[],
  now: number,
): CurrentActivity | undefined {
  const running = toolCalls
    .filter((call) => call.status === "running")
    .sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!running) return undefined
  return { tool: running, elapsedMs: Math.max(0, now - running.startedAt) }
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rem = seconds % 60
  if (minutes < 60) return `${minutes}m ${rem}s`
  const hours = Math.floor(minutes / 60)
  const minRem = minutes % 60
  return `${hours}h ${minRem}m`
}

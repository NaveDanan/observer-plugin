import type { AgentAssignment, HostId } from "@observer-ai/protocol"
import { z } from "zod"

/**
 * One global creation policy for every observed host.
 *
 * `maxDepth` counts subagent edges below the root. Zero disables delegation,
 * one permits root -> subagent, and two permits one nested subagent level.
 * `maxPerSession` is a lifetime count: finished subagents still consume a
 * slot, while resuming an existing runtime id does not.
 */
export interface SubagentLimits {
  maxDepth: number
  maxPerSession: number
}

export const MAX_CONFIGURED_SUBAGENT_DEPTH = 32
export const MAX_CONFIGURED_SUBAGENTS_PER_SESSION = 256

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
  maxDepth: 2,
  maxPerSession: 15,
}

export const SubagentLimitsSchema = z.object({
  maxDepth: z.number().int().min(0).max(MAX_CONFIGURED_SUBAGENT_DEPTH),
  maxPerSession: z.number().int().min(0).max(MAX_CONFIGURED_SUBAGENTS_PER_SESSION),
})

export interface SubagentCandidate {
  host: HostId
  rootSessionKey: string
  parentRuntimeId: string
}

/**
 * The durable admission rule shared by the HTTP controller and observed-host
 * reconciliation. Returning a sentence instead of throwing lets every host
 * present the same refusal through its own hook response shape.
 */
export function subagentAdmissionError(
  assignments: AgentAssignment[],
  candidate: SubagentCandidate,
  limits: SubagentLimits,
): string | undefined {
  if (assignments.length >= limits.maxPerSession) {
    return `subagent limit reached (${limits.maxPerSession} per session)`
  }

  const parent =
    candidate.parentRuntimeId === candidate.rootSessionKey
      ? undefined
      : assignments.find((assignment) => assignment.runtimeId === candidate.parentRuntimeId)
  if (candidate.parentRuntimeId !== candidate.rootSessionKey && !parent) {
    return "parent assignment not found in this session"
  }

  let depth = 1
  if (parent) {
    depth = 2
    let cursor = parent
    const seen = new Set<string>()
    while (cursor.parentRuntimeId !== candidate.rootSessionKey) {
      if (seen.has(cursor.id)) return "assignment parent cycle"
      seen.add(cursor.id)
      depth++
      const next = assignments.find((assignment) => assignment.runtimeId === cursor.parentRuntimeId)
      if (!next) return "parent assignment not found in this session"
      cursor = next
    }
  }

  if (depth > limits.maxDepth) {
    return `subagent depth limit reached (${limits.maxDepth + 1} session levels)`
  }
  return undefined
}

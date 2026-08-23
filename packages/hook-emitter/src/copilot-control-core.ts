import {
  copilotSeatAgentName,
  copilotSeatAgentReference,
  readCopilotTarget,
  seatFor,
  seatTargets,
} from "@observer-ai/daemon"
import type { ObserverConfig } from "@observer-ai/daemon"
import type { CopilotSeatTarget } from "@observer-ai/daemon"
import { matchEmployee } from "@observer-ai/roster"

/** Copilot's only built-in worker whose prompt and tools are intentionally general. */
export const COPILOT_NEUTRAL_AGENT_TYPES = new Set(["general-purpose"])

export interface CopilotPreToolUseInput {
  toolName?: unknown
  toolArgs?: unknown
}

export interface CopilotControlConfig {
  seats?: ObserverConfig["seats"]
}

export interface CopilotControlOutput {
  modifiedArgs: Record<string, unknown>
}

/**
 * Routes one neutral Copilot delegation through the employee matched to it.
 *
 * The complete task object is copied before `agent_type` changes. Returning
 * undefined means "emit {}", which is Copilot's documented fail-open response.
 */
export function controlCopilotDelegation(
  input: CopilotPreToolUseInput,
  config: CopilotControlConfig,
  agentReady: (name: string, reference: string, target: CopilotSeatTarget) => boolean,
): CopilotControlOutput | undefined {
  if (input.toolName !== "task") return undefined
  const args = readToolArgs(input.toolArgs)
  if (!args) return undefined
  if (typeof args["prompt"] !== "string" || args["prompt"].trim().length === 0) return undefined
  if (typeof args["agent_type"] !== "string" || !COPILOT_NEUTRAL_AGENT_TYPES.has(args["agent_type"])) {
    return undefined
  }

  const seats = config.seats
  if (!seats || seats.control !== true || !isRecord(seats.employees)) return undefined

  const match = matchEmployee(args["prompt"])
  if (!match) return undefined
  const spec = seatFor(seats, match.profile.id)
  if (!spec) return undefined

  const target = readCopilotTarget(
    Object.values(seatTargets(spec)).find((candidate) => candidate?.host === "copilot"),
  )
  if (!target) return undefined

  const agentName = copilotSeatAgentName(match.profile.id)
  const agentReference = copilotSeatAgentReference(match.profile.id)
  if (!agentReady(agentName, agentReference, target)) return undefined

  return {
    modifiedArgs: {
      ...args,
      agent_type: agentReference,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readToolArgs(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== "string") return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

import type { HostId } from "@observer-ai/protocol"
import type { Adapter, AdapterEvent, HookRequest } from "./types.js"
import { claudeAdapter } from "./claude.js"
import { codexAdapter } from "./codex.js"
import { copilotAdapter } from "./copilot.js"
import { opencodeAdapter } from "./opencode.js"

export * from "./types.js"
export { claudeAdapter, codexAdapter, copilotAdapter, opencodeAdapter }

export const ADAPTERS: Record<HostId, Adapter> = {
  opencode: opencodeAdapter,
  codex: codexAdapter,
  claude: claudeAdapter,
  copilot: copilotAdapter,
}

/**
 * Translates one host hook delivery into normalized events.
 *
 * Never throws: a malformed or unknown payload yields an empty list so that a
 * bad event can never break a user's agent session.
 */
export function normalizeHook(request: HookRequest): AdapterEvent[] {
  const adapter = ADAPTERS[request.host]
  if (!adapter) return []
  try {
    return adapter.normalize(request)
  } catch {
    return []
  }
}

export function adapterIdFor(host: HostId): string {
  return ADAPTERS[host]?.adapterId ?? `${host}-unknown`
}

/**
 * Whether the host's adapter recognises this delivery and deliberately
 * produces nothing for it.
 *
 * Answers `false` whenever it cannot be sure - unknown host, adapter with no
 * opinion, or an adapter that threw - because the safe default is to report an
 * empty result as a gap in Observer's coverage rather than hide it.
 */
export function ignoresHook(request: HookRequest): boolean {
  const adapter = ADAPTERS[request.host]
  if (!adapter?.ignores) return false
  try {
    return adapter.ignores(request)
  } catch {
    return false
  }
}

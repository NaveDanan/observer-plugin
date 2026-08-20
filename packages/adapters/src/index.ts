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

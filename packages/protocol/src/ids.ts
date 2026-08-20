/**
 * Stable identifier helpers.
 *
 * Every entity id is derived deterministically from host-provided keys so that
 * replayed, duplicated or out-of-order events converge on the same row instead
 * of creating duplicates.
 */

/**
 * Separator for composite ids.
 *
 * Must be printable and URL-safe: ids travel through SQLite text columns and
 * REST path parameters, and a control character breaks both.
 */
const SEP = "~"

function sanitize(value: string): string {
  return value.replace(/~/g, "-")
}

export function sessionId(host: string, sessionKey: string): string {
  return `${sanitize(host)}:${sanitize(sessionKey)}`
}
export function agentId(sessionId: string, agentKey: string): string {
  return `${sessionId}${SEP}${sanitize(agentKey)}`
}

export function messageId(agentId: string, messageKey: string): string {
  return `${agentId}${SEP}m:${sanitize(messageKey)}`
}

export function toolCallId(agentId: string, callId: string): string {
  return `${agentId}${SEP}t:${sanitize(callId)}`
}

export function todoId(agentId: string, position: number): string {
  return `${agentId}${SEP}todo:${position}`
}

export function promptFragmentId(agentId: string, fragmentKey: string): string {
  return `${agentId}${SEP}p:${sanitize(fragmentKey)}`
}

export function edgeId(sessionId: string, from: string, to: string, type: string): string {
  return `${sessionId}${SEP}e:${sanitize(from)}>${sanitize(to)}:${sanitize(type)}`
}

/** The synthetic agent key used for a host's primary/root agent. */
export const MAIN_AGENT_KEY = "main"

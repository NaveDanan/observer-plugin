/**
 * Delivery diagnostics.
 *
 * Observer must never break a host session, so every failure path is
 * swallowed: a malformed payload, an event no adapter understands, or content
 * removed by capture settings all end the same way - nothing appears on the
 * canvas. That is indistinguishable from "the agent did nothing".
 *
 * This module makes those drops countable and inspectable, without storing the
 * payloads themselves: only top-level key names are kept, never values.
 */

export type DropReason =
  /** No adapter produced events: unknown event name, or missing session id. */
  | "unmapped"
  /** The hook payload was not valid JSON when it reached the emitter. */
  | "malformed"
  /** An adapter produced an event that failed schema validation. */
  | "invalid"
  /** Removed deliberately by capture settings. Not a fault. */
  | "filtered"
  /** Already stored; expected during spool replay. Not a fault. */
  | "duplicate"

export interface DropSample {
  at: number
  host: string
  event: string
  reason: DropReason
  detail?: string
  /** Top-level payload keys, to spot a missing `session_id` without storing content. */
  payloadKeys: string[]
}

export interface DiagnosticsSnapshot {
  accepted: number
  counters: Record<DropReason, number>
  /** Reasons that indicate something is actually wrong. */
  faults: number
  lastAcceptedByHost: Record<string, number>
  recent: DropSample[]
}

const EMPTY_COUNTERS: Record<DropReason, number> = {
  unmapped: 0,
  malformed: 0,
  invalid: 0,
  filtered: 0,
  duplicate: 0,
}

/** Reasons worth surfacing as a problem; the others are normal operation. */
export const FAULT_REASONS: DropReason[] = ["unmapped", "malformed", "invalid"]

export class Diagnostics {
  private readonly counters: Record<DropReason, number> = { ...EMPTY_COUNTERS }
  private readonly samples: DropSample[] = []
  private readonly lastAccepted = new Map<string, number>()
  private readonly capacity: number
  private acceptedCount = 0

  constructor(capacity = 100) {
    this.capacity = capacity
  }

  markAccepted(host: string, at = Date.now()): void {
    this.acceptedCount++
    this.lastAccepted.set(host, at)
  }

  record(input: {
    host: string
    event: string
    reason: DropReason
    detail?: string
    payload?: unknown
  }): void {
    this.counters[input.reason]++
    // Only faults are worth keeping examples of; filtered and duplicate are
    // expected in normal operation and would crowd out the useful entries.
    if (!FAULT_REASONS.includes(input.reason)) return
    this.samples.push({
      at: Date.now(),
      host: input.host,
      event: input.event,
      reason: input.reason,
      detail: input.detail,
      payloadKeys: topLevelKeys(input.payload),
    })
    if (this.samples.length > this.capacity) this.samples.shift()
  }

  get faults(): number {
    return FAULT_REASONS.reduce((total, reason) => total + this.counters[reason], 0)
  }

  snapshot(limit = 25): DiagnosticsSnapshot {
    return {
      accepted: this.acceptedCount,
      counters: { ...this.counters },
      faults: this.faults,
      lastAcceptedByHost: Object.fromEntries(this.lastAccepted),
      recent: this.samples.slice(-limit).reverse(),
    }
  }

  reset(): void {
    for (const reason of Object.keys(this.counters) as DropReason[]) this.counters[reason] = 0
    this.samples.length = 0
    this.lastAccepted.clear()
    this.acceptedCount = 0
  }
}

/** Key names only: enough to diagnose a shape mismatch, with no content. */
function topLevelKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return []
  return Object.keys(payload as Record<string, unknown>).slice(0, 20)
}

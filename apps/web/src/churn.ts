import type { AgentEntity, Provenance } from "@observer-ai/protocol"

/**
 * How much code an Agent moved, ready to render.
 *
 * `added` and `removed` are pre-formatted with their signs still attached
 * (`"+128"`, `"-34"`) because the sign is not decoration here: colour alone
 * must never carry the meaning, so the glyph travels with the number through
 * every surface — the node, the panel, a copied string, a screen reader.
 */
export interface ChurnSummary {
  /** `"+128"`, or null when the host never reported additions. */
  added: string | null
  /** `"-34"`, or null when the host never reported removals. */
  removed: string | null
  /** Both halves joined: `"+128 -34"`. */
  text: string
  /** Spoken form for `aria-label` and `title`: `"128 lines added, 34 removed"`. */
  label: string
  /** How the figure was obtained, or null when the reducer did not say. */
  provenance: Provenance | null
  /**
   * True when the number is anything short of a host's own statement, and so
   * must not be presented as fact. Mirrors the `modelConfidence` test used in
   * `DetailPanel`: authoritative renders bare, everything else gets a marker.
   */
  inferred: boolean
}

/** The churn fields, so callers can pass an Agent or a bare fixture. */
export type ChurnSource = Pick<AgentEntity, "linesAdded" | "linesRemoved" | "churnConfidence">

/**
 * The churn an Agent should display, or `null` meaning *show nothing at all*.
 *
 * The gate is `undefined`, never `0`, and that distinction is the whole point
 * of this function. An Agent whose edits cancelled out carries
 * `linesAdded: 0, linesRemoved: 0` — it really did rewrite files, and `+0 -0`
 * is the honest report of that. An Agent that only ever *read* files carries
 * neither field, and must show no badge, because a `+0 -0` there would claim
 * we measured something we never measured. The protocol made these fields
 * optional rather than nullable precisely to keep the two apart
 * (`entities.ts`, `linesAdded`), and collapsing them at the render step would
 * throw that away at the last possible moment.
 *
 * Each half is gated independently. The reducer writes both together today,
 * but the type permits one without the other, and the honest response to a
 * missing half is to omit it rather than to substitute a zero.
 *
 * Nothing is summed here, and nothing ever should be. `ToolCallEntity` carries
 * these same field names as the reducer's per-call idempotency ledger; adding
 * those rows up in the browser would count every edit a second time. The
 * totals on the Agent are already summed and already deduplicated.
 */
export function churnSummary(source: ChurnSource): ChurnSummary | null {
  const { linesAdded, linesRemoved } = source
  if (linesAdded === undefined && linesRemoved === undefined) return null

  const added = linesAdded === undefined ? null : `+${linesAdded}`
  const removed = linesRemoved === undefined ? null : `-${linesRemoved}`
  const provenance = source.churnConfidence ?? null

  const spoken: string[] = []
  if (linesAdded !== undefined) spoken.push(`${linesAdded} lines added`)
  if (linesRemoved !== undefined) spoken.push(`${linesRemoved} removed`)

  return {
    added,
    removed,
    text: [added, removed].filter((part) => part !== null).join(" "),
    label: spoken.join(", "),
    provenance,
    inferred: provenance !== null && provenance !== "authoritative",
  }
}

/**
 * The tooltip and spoken description for a churn figure, provenance included.
 *
 * An inferred total says so in words rather than leaning on the `~` marker
 * alone, for the same reason the sign travels with the number: a visual
 * shorthand that only sighted users can decode is not an explanation.
 */
export function churnTitle(summary: ChurnSummary): string {
  if (!summary.inferred) return summary.label
  return `${summary.label} — ${summary.provenance} from tool arguments, not stated by the host`
}

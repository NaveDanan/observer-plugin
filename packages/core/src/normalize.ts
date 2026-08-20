import type { TodoStatus } from "@observer-ai/protocol"

/**
 * Maps a host's own task status vocabulary onto Observer's normalized set.
 *
 * The original string is always preserved separately by callers so the UI can
 * show the host's wording rather than pretending every host agrees.
 */
export function normalizeTodoStatus(raw: string | undefined | null): TodoStatus {
  if (!raw) return "unknown"
  const value = raw.trim().toLowerCase().replace(/[\s-]+/g, "_")
  switch (value) {
    case "pending":
    case "todo":
    case "not_started":
    case "queued":
    case "open":
      return "pending"
    case "in_progress":
    case "inprogress":
    case "active":
    case "running":
    case "started":
    case "doing":
      return "in_progress"
    case "completed":
    case "complete":
    case "done":
    case "finished":
    case "succeeded":
      return "completed"
    case "cancelled":
    case "canceled":
    case "skipped":
    case "abandoned":
      return "cancelled"
    case "blocked":
    case "waiting":
    case "paused":
      return "blocked"
    default:
      return "unknown"
  }
}

/** Derives a short session goal from the first user prompt. */
export function deriveGoal(text: string, maxLength = 240): string {
  const cleaned = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim()
  if (cleaned.length <= maxLength) return cleaned
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}\u2026`
}

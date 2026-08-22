/**
 * How long ago something happened, in the fewest words that stay true.
 *
 * The session list orders rows by *creation* time so they never reshuffle
 * under the reader's cursor. That stability costs the one thing the old
 * `updatedAt` ordering communicated for free — which session is warm — so
 * every row now carries that fact as text instead of as position.
 *
 * Recent work is phrased in relative terms because "4m ago" answers "is this
 * still going?" without arithmetic. Past a week the relative form stops being
 * an answer and starts being a puzzle ("63d ago" — so, which month?), so it
 * hands over to an absolute date. The handover point is deliberately inside
 * the range where both forms are still readable, rather than at the edge
 * where one has already become useless.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Past this, a relative figure stops locating an event and starts hiding it. */
const RELATIVE_HORIZON = 7 * DAY

export interface RelativeTime {
  /** The short form for the row: "4m ago", "12 Mar". */
  label: string
  /** The unabbreviated timestamp, for a `title` and the `datetime` attribute. */
  absolute: string
}

/**
 * Formats `timestamp` against `now`.
 *
 * `now` is a parameter rather than a `Date.now()` call so the function stays
 * pure and testable, and so a list of rows rendered in one pass all agree on
 * what "now" was — otherwise two rows a millisecond apart can disagree about
 * which minute it is.
 */
export function relativeTime(timestamp: number, now: number): RelativeTime {
  const date = new Date(timestamp)
  const absolute = date.toLocaleString()
  // Clock skew between the daemon's host and this browser can put an event a
  // few seconds into the future. "in 3s" would read as a bug, so the future
  // collapses into the same "just now" bucket the recent past uses.
  const elapsed = Math.max(0, now - timestamp)

  if (elapsed < MINUTE) return { label: "just now", absolute }
  if (elapsed < HOUR) return { label: `${Math.floor(elapsed / MINUTE)}m ago`, absolute }
  if (elapsed < DAY) return { label: `${Math.floor(elapsed / HOUR)}h ago`, absolute }
  if (elapsed < RELATIVE_HORIZON) return { label: `${Math.floor(elapsed / DAY)}d ago`, absolute }

  // Older than the horizon: an absolute date. The year is dropped inside the
  // current one, where it is the same for every row and so carries no signal.
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return {
    label: date.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      ...(sameYear ? {} : { year: "numeric" }),
    }),
    absolute,
  }
}

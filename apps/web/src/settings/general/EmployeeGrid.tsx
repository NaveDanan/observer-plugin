/**
 * The employee grid: the roster, with each person's seat readable at a glance.
 *
 * `observer config` had to answer "who is seated" in a five-column text table
 * that truncated a model id to fit. A grid of cards spends the space it has on
 * the two things the table could not carry — the photo, so the person on the
 * card is the person on the canvas, and the seat summary in full — and keeps
 * the terminal's one genuinely good idea: the model the user chose is the
 * highlighted value, and `inherit` reads as the absence of a choice.
 */

import { useState } from "react"
import type { RosterProfile } from "@observer-ai/roster"
import type { SeatIssue, SeatSpec } from "../../api"
import { Badge } from "../../ui/primitives"
import { cn } from "../../lib/utils"
import { badgeVariant, isSeated, issuesFor, seatSummary } from "./seat"

/** Name, title and strengths: the three things a card shows and a search reads. */
export function matchesQuery(profile: RosterProfile, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = `${profile.fullName} ${profile.title} ${profile.fields.join(" ")}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

export function EmployeeGrid({
  profiles,
  employees,
  issues,
  onOpen,
}: {
  profiles: ReadonlyArray<RosterProfile>
  employees: Record<string, SeatSpec>
  issues: ReadonlyArray<SeatIssue>
  onOpen: (profile: RosterProfile) => void
}): JSX.Element {
  if (profiles.length === 0) {
    return (
      <p role="status" className="px-1 py-6 text-center text-[13px] text-muted-foreground">
        Nobody on the roster matches that.
      </p>
    )
  }
  return (
    <ul className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
      {profiles.map((profile) => (
        <li key={profile.id}>
          <EmployeeCard
            profile={profile}
            spec={employees[profile.id]}
            issues={issuesFor(issues, profile.id)}
            onOpen={() => onOpen(profile)}
          />
        </li>
      ))}
    </ul>
  )
}

function EmployeeCard({
  profile,
  spec,
  issues,
  onOpen,
}: {
  profile: RosterProfile
  spec: SeatSpec | undefined
  issues: ReadonlyArray<SeatIssue>
  onOpen: () => void
}): JSX.Element {
  // A portrait that 404s degrades to initials rather than a broken-image box,
  // the same way the canvas node and the worker card do.
  const [broken, setBroken] = useState(false)
  const seated = isSeated(spec)
  const summary = seatSummary(spec)

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Edit ${profile.fullName}'s seat`}
      className={cn(
        "flex h-full w-full cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-card/40 p-3 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        seated && "bg-card/70 ring-1 ring-primary/25",
      )}
    >
      <span className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
        {broken ? (
          <span aria-hidden="true" className="text-sm font-medium text-muted-foreground">
            {initials(profile.fullName)}
          </span>
        ) : (
          <img
            src={profile.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setBroken(true)}
            className="size-full rounded-lg object-cover object-top"
          />
        )}
      </span>

      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">{profile.fullName}</span>
          {seated ? null : <span className="shrink-0 text-[11px] text-muted-foreground/70">no seat</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{profile.title}</span>

        <span className="flex flex-wrap gap-1 pt-0.5">
          {profile.fields.slice(0, 3).map((field) => (
            <Badge key={field} variant="outline" size="sm">
              {field}
            </Badge>
          ))}
        </span>

        {summary !== undefined ? (
          <span className="block truncate pt-0.5 font-mono text-[11px] text-primary">{summary}</span>
        ) : null}

        {issues.length > 0 ? (
          <span className="flex flex-col gap-1 pt-1">
            {issues.map((issue) => (
              <Badge
                key={`${issue.code}:${issue.path}`}
                variant={badgeVariant(issue.severity)}
                size="sm"
                className="w-full items-start whitespace-normal text-left"
              >
                <span className="line-clamp-2">{issue.message}</span>
              </Badge>
            ))}
          </span>
        ) : null}
      </span>
    </button>
  )
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
}

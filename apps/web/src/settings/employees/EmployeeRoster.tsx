/**
 * The employee list: everyone on the roster, with what they are configured to
 * run and what Observer will really do about it.
 *
 * Pure props, no hooks, no fetching — which is what lets
 * `apps/web/test/employeeRoster.test.ts` render it with `renderToStaticMarkup`
 * and assert the `data-employee-id` attributes come out equal to
 * `ROSTER.map(p => p.id)`, in order. That test is the guard the ticket asks for:
 * a fifteenth hire cannot silently vanish from this screen, because the screen
 * is a map over the roster and a test watches the output rather than the
 * intention.
 *
 * A card carries three things a terminal table could not: the photo, so the
 * person here is the person on the canvas; every configured target in full
 * rather than truncated to a column; and a status badge per target, so the
 * difference between "OpenCode will apply this" and "Cursor will not" is
 * visible without opening anything.
 */

import { useState } from "react"
import type { SeatIssue } from "../../api"
import { Badge } from "../../ui/primitives"
import { cn } from "../../lib/utils"
import type { HostDirectory } from "./hosts"
import type { EmployeeRow } from "./roster"
import { targetSummary } from "./roster"
import { badgeVariant } from "./seat"
import { controlVerdict } from "./status"
import { isTarget, targetHost } from "./targets"

export function EmployeeRoster({
  rows,
  directory,
  seatControl,
  onOpen,
}: {
  rows: ReadonlyArray<EmployeeRow>
  directory: HostDirectory
  seatControl: boolean
  onOpen: (employeeId: string) => void
}): JSX.Element {
  if (rows.length === 0) {
    return (
      <p role="status" className="px-1 py-6 text-center text-[13px] text-muted-foreground">
        Nobody on the roster matches that.
      </p>
    )
  }
  return (
    <ul data-employee-roster className="grid grid-cols-1 gap-2 pt-1 lg:grid-cols-2">
      {rows.map((row) => (
        <li key={row.id} data-employee-id={row.id}>
          <EmployeeCard row={row} directory={directory} seatControl={seatControl} onOpen={() => onOpen(row.id)} />
        </li>
      ))}
    </ul>
  )
}

function EmployeeCard({
  row,
  directory,
  seatControl,
  onOpen,
}: {
  row: EmployeeRow
  directory: HostDirectory
  seatControl: boolean
  onOpen: () => void
}): JSX.Element {
  // A portrait that 404s degrades to initials rather than a broken-image box,
  // the same way the canvas node and the worker card do.
  const [broken, setBroken] = useState(false)
  const { profile } = row

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Edit ${profile.fullName}'s seat`}
      className={cn(
        "flex h-full w-full cursor-pointer items-start gap-3 rounded-xl border border-border/70 bg-card/40 p-3 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        row.seated && "bg-card/70 ring-1 ring-primary/25",
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
          {row.seated ? null : <span className="shrink-0 text-[11px] text-muted-foreground/70">no seat</span>}
        </span>
        <span className="block truncate text-xs text-muted-foreground">{profile.title}</span>

        {row.targets.length === 0 ? (
          <span className="flex flex-wrap gap-1 pt-0.5">
            {profile.fields.slice(0, 3).map((field) => (
              <Badge key={field} variant="outline" size="sm">
                {field}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="flex flex-col gap-1 pt-1">
            {row.targets.map((target) => {
              const host = targetHost(target.target)
              const verdict = controlVerdict(directory, host, seatControl)
              return (
                <span key={target.id} className="flex items-start justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-primary">
                    {isTarget(target.target) ? targetSummary(directory, target) : `${target.id} — not a target`}
                  </span>
                  <Badge variant={verdict.tone} size="sm">
                    {verdict.label}
                  </Badge>
                </span>
              )
            })}
          </span>
        )}

        {row.skillCount > 0 ? (
          <span className="block pt-0.5 text-[11px] text-muted-foreground">
            {row.skillCount} skill{row.skillCount === 1 ? "" : "s"}, applied on every host
          </span>
        ) : null}

        {row.issues.length > 0 ? (
          <span className="flex flex-col gap-1 pt-1">
            {row.issues.map((issue: SeatIssue) => (
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

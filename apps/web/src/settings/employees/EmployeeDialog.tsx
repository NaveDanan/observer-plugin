/**
 * One employee's whole seat: their host targets and their skills.
 *
 * A dialog rather than an inline expander. The list is fourteen cards deep and
 * expanding one in place would reflow every card after it; the editor holds up
 * to five target cards, each with a filter, two pickers and a variable stack of
 * option controls, which is more than a settings row's control column can hold.
 * The dialog also inherits the page's Escape contract — `SettingsPage` already
 * declines to close the page while a `[role="dialog"]` is mounted.
 *
 * There is no Save button. Every commit goes through the shared optimistic
 * `save()` and adopts the daemon's normalised answer, which is how a bare skill
 * name typed here comes back as `{ name, description }` without the user doing
 * anything.
 *
 * The two halves are separated on purpose and the copy says why: skills are
 * prompt text folded into a behaviour directive and they apply whether or not
 * seat control is on, while a target's model is a substitution that only some
 * hosts can perform and only with consent. Presenting them as one "seat" would
 * make the honest per-target status read as pedantry.
 */

import { useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, Trash2Icon } from "lucide-react"
import type { RosterProfile } from "@observer-ai/roster"
import type { SeatIssue, SeatSkill, SeatSpec, SeatTarget } from "../../api"
import { Badge, Button, Dialog, DraftInput, Input, Select } from "../../ui/primitives"
import { cn } from "../../lib/utils"
import { hostOfTargetId, targetTitle } from "./directory"
import type { HostDirectory } from "./hosts"
import { targetSummary } from "./roster"
import { badgeVariant, issuesForTarget, issuesWithoutTarget, seatSkills, setSkills } from "./seat"
import { controlVerdict } from "./status"
import { TargetEditor } from "./TargetEditor"
import { isTarget, removeTarget, targetHost, targetRows, writeTarget } from "./targets"

export function EmployeeDialog({
  profile,
  spec,
  seatControl,
  issues,
  directory,
  saving,
  onChange,
  onClearSeat,
  onClose,
}: {
  profile: RosterProfile
  spec: SeatSpec | undefined
  seatControl: boolean
  /** `diagnoseSeats`' findings for this employee, rendered verbatim. */
  issues: ReadonlyArray<SeatIssue>
  directory: HostDirectory
  saving: boolean
  /** A complete replacement spec. */
  onChange: (next: SeatSpec) => void
  onClearSeat: () => void
  onClose: () => void
}): JSX.Element {
  const [newSkill, setNewSkill] = useState<SeatSkill>({ name: "", description: "" })
  /** Set when a name edit was refused, so the field does not just snap back. */
  const [nameRefused, setNameRefused] = useState(false)
  /**
   * The one expanded target, and the reason the list is an accordion.
   *
   * `TargetEditor` fetches `/v1/hosts/:host/models` on mount, and that call can
   * spawn a CLI. Rendering all five cards at once would probe five hosts the
   * moment an employee was opened — four of which the user did not ask about
   * and, on most machines, are not installed. Expanding is the user saying
   * "this one", so expanding is when the probe happens.
   */
  const [open, setOpen] = useState<string | undefined>(undefined)

  const rows = targetRows(spec)
  const skills = seatSkills(spec)
  const taken = rows.map((row) => row.id)

  /**
   * The profiles that could take a new target: every host's, minus the ones
   * already in use.
   *
   * Read off the directory rather than assembled from host names, so a second
   * install the daemon reports one day appears here without this file changing.
   */
  const addable = directory.hosts.flatMap((entry) =>
    entry.profiles
      .filter((hostProfile) => !taken.includes(hostProfile.id))
      .map((hostProfile) => ({
        value: hostProfile.id,
        label: targetTitle(directory, hostProfile.id, entry.id),
        group: controlVerdict(directory, entry.id, seatControl).label,
      })),
  )

  const addTarget = (targetId: string): void => {
    const entry = directory.hosts.find((candidate) =>
      candidate.profiles.some((hostProfile) => hostProfile.id === targetId),
    )
    // An empty target is a legitimate save: the daemon reports it as
    // `empty-target` at `info`, which is the right severity for a row the user
    // has just created and not yet filled in.
    onChange(writeTarget(spec, targetId, { host: entry?.id ?? hostOfTargetId(targetId) }))
    // Opened immediately, which also means its catalogue is fetched now — the
    // user just said this is the host they care about.
    setOpen(targetId)
  }

  const commitSkills = (next: SeatSkill[]): void => {
    setNameRefused(false)
    onChange(setSkills(spec, next))
  }

  const seatIssues = issuesWithoutTarget(issues)

  return (
    <Dialog
      open
      onClose={onClose}
      className="max-w-3xl"
      title={
        <span className="flex items-center gap-2">
          {profile.fullName}
          {saving ? <span className="text-xs font-normal text-muted-foreground">saving…</span> : null}
        </span>
      }
      description={profile.title}
      footer={
        <>
          <Button variant="destructive-outline" size="sm" disabled={spec === undefined} onClick={onClearSeat}>
            <Trash2Icon />
            Clear seat
          </Button>
          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="space-y-6 pb-2">
        {seatIssues.length > 0 ? (
          <ul className="space-y-1.5">
            {seatIssues.map((issue) => (
              <li key={`${issue.code}:${issue.path}`}>
                <Badge
                  variant={badgeVariant(issue.severity)}
                  className="w-full items-start whitespace-normal text-left"
                >
                  {issue.message}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}

        <section className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-sm font-medium tracking-[-0.005em] text-foreground">Host targets</h3>
            <p className="text-[13px] leading-[1.45] text-muted-foreground/80">
              What {profile.fullName.split(" ")[0]} should run on each host: a model id in that host's own spelling,
              plus whatever options that host describes for it. Each card says what Observer will really do with it.
            </p>
          </div>

          {rows.length === 0 ? (
            <p className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-[13px] leading-[1.45] text-muted-foreground">
              No targets. {profile.fullName} is seated exactly as the roster describes them, on whatever model the
              session is already running.
            </p>
          ) : null}

          {rows.map((row) => {
            const host = targetHost(row.target)
            const verdict = controlVerdict(directory, host, seatControl)
            const expanded = open === row.id
            const rowIssues = issuesForTarget(issues, row.id)

            if (!isTarget(row.target)) {
              // A `targets.t: 7` from a hand-edited file. The daemon keeps it
              // and reports `malformed-target`; the editor shows it with a way
              // out rather than drawing a form around a number.
              return (
                <div
                  key={row.id}
                  className="flex items-center justify-between gap-2 rounded-xl border border-border/70 bg-card/40 p-3"
                >
                  <span className="min-w-0 font-mono text-[11px] text-foreground">{row.id}</span>
                  <Button size="sm" variant="destructive-outline" onClick={() => onChange(removeTarget(spec, row.id))}>
                    Delete
                  </Button>
                </div>
              )
            }

            return (
              <div key={row.id} className="rounded-xl border border-border/70 bg-card/40 p-3">
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`target-editor-${row.id}`}
                  onClick={() => setOpen(expanded ? undefined : row.id)}
                  className="flex w-full cursor-pointer items-start gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {expanded ? (
                    <ChevronDownIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {targetTitle(directory, row.id, host)}
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={verdict.tone}>{verdict.label}</Badge>
                        {verdict.requiresReload ? <Badge variant="outline">needs a restart</Badge> : null}
                        {rowIssues.length > 0 ? (
                          <Badge variant={badgeVariant(rowIssues[0]?.severity ?? "info")} size="sm">
                            {rowIssues.length} finding{rowIssues.length === 1 ? "" : "s"}
                          </Badge>
                        ) : null}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "block truncate font-mono text-[11px]",
                        expanded ? "text-muted-foreground/70" : "text-primary",
                      )}
                    >
                      {expanded ? row.id : targetSummary(directory, row)}
                    </span>
                  </span>
                </button>

                {expanded ? (
                  <div id={`target-editor-${row.id}`}>
                    <TargetEditor
                      targetId={row.id}
                      target={row.target}
                      derived={row.derived}
                      directory={directory}
                      seatControl={seatControl}
                      issues={rowIssues}
                      onChange={(next: SeatTarget) => onChange(writeTarget(spec, row.id, next))}
                      onClear={() => {
                        setOpen(undefined)
                        onChange(removeTarget(spec, row.id))
                      }}
                    />
                  </div>
                ) : null}
              </div>
            )
          })}

          {addable.length > 0 ? (
            <div className="flex items-center gap-2">
              <div className="w-full sm:w-72">
                <Select
                  value={undefined}
                  options={addable}
                  ariaLabel={`Add a host target for ${profile.fullName}`}
                  placeholder="Add a host target…"
                  onValueChange={addTarget}
                />
              </div>
              <PlusIcon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
            </div>
          ) : null}
        </section>

        <section className="space-y-2">
          <div className="space-y-1">
            <h3 className="text-sm font-medium tracking-[-0.005em] text-foreground">Skills</h3>
            <p className="text-[13px] leading-[1.45] text-muted-foreground/80">
              Prompt text folded into this employee's behaviour directive, shared by every target. Skills are not gated
              on seat control and they cannot fail a delegation, so they apply on all five hosts either way.
            </p>
          </div>

          {skills.map((skill, index) => (
            <div key={`${index}:${skill.name}`} className="flex items-start gap-2">
              <div className="w-40 shrink-0">
                <DraftInput
                  inputSize="sm"
                  value={skill.name}
                  aria-label={`Skill ${index + 1} name`}
                  onCommit={(value) => {
                    // A nameless skill is dropped by the daemon's schema, and it
                    // drops the whole `skills` array with it — so an empty name
                    // is refused here rather than saved and mourned.
                    if (value.trim().length === 0) {
                      setNameRefused(true)
                      return
                    }
                    commitSkills(skills.map((entry, at) => (at === index ? { ...entry, name: value.trim() } : entry)))
                  }}
                />
              </div>
              <div className="min-w-0 flex-1">
                <DraftInput
                  inputSize="sm"
                  value={skill.description}
                  placeholder="What it means, in the words the agent will read"
                  aria-label={`Skill ${index + 1} description`}
                  onCommit={(value) =>
                    commitSkills(skills.map((entry, at) => (at === index ? { ...entry, description: value } : entry)))
                  }
                />
              </div>
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={`Remove skill ${skill.name}`}
                onClick={() => commitSkills(skills.filter((_, at) => at !== index))}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}

          <div className="flex items-start gap-2">
            <div className="w-40 shrink-0">
              <Input
                inputSize="sm"
                value={newSkill.name}
                placeholder="Skill name"
                aria-label="New skill name"
                onChange={(event) => setNewSkill((current) => ({ ...current, name: event.currentTarget.value }))}
              />
            </div>
            <div className="min-w-0 flex-1">
              <Input
                inputSize="sm"
                value={newSkill.description}
                placeholder="Description (optional)"
                aria-label="New skill description"
                onChange={(event) => setNewSkill((current) => ({ ...current, description: event.currentTarget.value }))}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || newSkill.name.trim().length === 0) return
                  commitSkills([...skills, { name: newSkill.name.trim(), description: newSkill.description }])
                  setNewSkill({ name: "", description: "" })
                }}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={newSkill.name.trim().length === 0}
              onClick={() => {
                commitSkills([...skills, { name: newSkill.name.trim(), description: newSkill.description }])
                setNewSkill({ name: "", description: "" })
              }}
            >
              <PlusIcon />
              Add
            </Button>
          </div>
          {nameRefused ? (
            <p role="status" className="text-xs text-warning-foreground">
              A skill needs a name, so that edit was not saved. Remove the skill instead if you no longer want it.
            </p>
          ) : null}
        </section>

        <div className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">In effect</p>
          <p className="pt-0.5 text-[13px] leading-[1.45] text-foreground">
            {inEffect(profile, rows.length, skills.length, rows, directory, seatControl)}
          </p>
        </div>
      </div>
    </Dialog>
  )
}

/**
 * What this seat does once it is saved, in one sentence.
 *
 * Deliberately a description and not a finding: it says what Observer will do
 * with the fields as written and leaves what is *wrong* with them to the badges
 * carrying the daemon's own messages. It counts the targets that will really be
 * applied rather than the targets that exist, because "five targets configured"
 * beside four hosts that ignore all of them is the exact overstatement this
 * surface was built to stop.
 */
function inEffect(
  profile: RosterProfile,
  targetCount: number,
  skillCount: number,
  rows: ReturnType<typeof targetRows>,
  directory: HostDirectory,
  seatControl: boolean,
): string {
  const applied = rows.filter(
    (row) => controlVerdict(directory, targetHost(row.target), seatControl).status === "applied",
  ).length

  const sentences: string[] = []
  if (targetCount > 0) {
    sentences.push(
      applied === 0
        ? `${targetCount} target${targetCount === 1 ? " is" : "s are"} recorded and none of them is applied to a delegated child right now.`
        : `${applied} of ${targetCount} target${targetCount === 1 ? "" : "s"} ${applied === 1 ? "is" : "are"} applied to delegated children; the rest are recorded only.`,
    )
  }
  if (skillCount > 0) {
    sentences.push(
      `${skillCount} skill${skillCount === 1 ? " is" : "s are"} folded into ${profile.fullName}'s directive on every host, whether or not seat control is on.`,
    )
  }
  if (sentences.length === 0) {
    return `Nothing is set, so ${profile.fullName} is seated exactly as the roster describes them.`
  }
  return sentences.join(" ")
}

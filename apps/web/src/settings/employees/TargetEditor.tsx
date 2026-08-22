/**
 * One host target, open for editing.
 *
 * Reading order on this card is deliberate and is the opposite of what a form
 * usually does: **status first, controls second**. A user about to spend two
 * minutes picking a model on a host that will not apply it should be told in
 * the first line, not discover it in a footnote after they have saved. The
 * research says the same — "show control capability beside each target before
 * selection".
 *
 * Everything below the status comes from the daemon and nothing from this file:
 * the model list is `GET /v1/hosts/:host/models`, the option controls are
 * whatever descriptors came back for the chosen model, and the free-text rows
 * exist for a host whose catalogue is empty or whose knobs Observer cannot
 * vouch for. There is no branch on a host's name anywhere in here.
 *
 * ## The card is where the subprocess happens
 *
 * `useHostCatalogue` fires on mount, and this component only mounts when its
 * row has been expanded. That is the whole laziness story: opening an employee
 * with five targets probes nothing, and expanding one probes one. A slow or
 * missing CLI shows a spinner and then the daemon's own sentence — never a
 * blank picker, never a broken-looking page, and never a blocked dialog.
 */

import { useState } from "react"
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import type { SeatIssue, SeatTarget } from "../../api"
import { Badge, Button, Input, Select } from "../../ui/primitives"
import { cn } from "../../lib/utils"
import {
  UNSET,
  catalogueNote,
  catalogueProfileNote,
  descriptorsFor,
  findHost,
  formatContext,
  freshnessLabel,
  hostLabel,
  modelOptions,
  profileForTarget,
  targetTitle,
} from "./directory"
import { useHostCatalogue } from "./hosts"
import type { HostDirectory } from "./hosts"
import { OptionField } from "./OptionField"
import { badgeVariant, malformedModelMessage } from "./seat"
import { controlVerdict } from "./status"
import { optionValue, retargetModel, setOption, targetHost, targetModel, targetOptions } from "./targets"

export function TargetEditor({
  targetId,
  target,
  derived,
  directory,
  seatControl,
  issues,
  onChange,
  onClear,
}: {
  targetId: string
  target: SeatTarget
  /** True when this row is the legacy `model`/`variant` pair, read as a target. */
  derived: boolean
  directory: HostDirectory
  seatControl: boolean
  /** `diagnoseSeats`' findings scoped to this target, rendered verbatim. */
  issues: ReadonlyArray<SeatIssue>
  onChange: (next: SeatTarget) => void
  onClear: () => void
}): JSX.Element {
  const [filter, setFilter] = useState("")
  const [typed, setTyped] = useState("")
  const [rawId, setRawId] = useState("")
  const [rawValue, setRawValue] = useState("")

  const host = targetHost(target)
  const entry = findHost(directory, host)
  const label = hostLabel(directory, host)
  const model = targetModel(target)
  const verdict = controlVerdict(directory, host, seatControl)

  // The one network call on this screen that can start a process, and it starts
  // here because here is where the user asked for it.
  const catalogue = useHostCatalogue(host, profileForTarget(entry, targetId))
  const { descriptors, note } = descriptorsFor(catalogue, label, model)

  const ready = catalogue.status === "ready" ? catalogue.catalogue : undefined
  const catalogueEntry = ready?.models.find((candidate) => candidate.id === model)
  const context = formatContext(catalogueEntry?.contextWindow)
  const profileNote = ready === undefined ? undefined : catalogueProfileNote(ready, targetId)
  const typedProblem = malformedModelMessage(host, typed.trim())

  /**
   * Requirement five, in one call: a new model re-derives the descriptors and
   * drops the values the new model does not offer. Derived here rather than in
   * an effect so the clamp lands on the same tick as the change — there is
   * never a frame in which a stale `variant` sits beside a model that rejects
   * it.
   *
   * The descriptors are read out of the catalogue that is already in hand, so
   * changing a model costs no request and cannot leave the option list one
   * model behind while a fetch is in flight.
   */
  const chooseModel = (next: string | undefined): void => {
    const nextDescriptors = descriptorsFor(catalogue, label, next).descriptors
    onChange(retargetModel(target, next, nextDescriptors))
  }

  const commitTyped = (): void => {
    const next = typed.trim()
    if (next.length === 0 || typedProblem !== undefined) return
    chooseModel(next)
    setTyped("")
  }

  const commitRaw = (): void => {
    const id = rawId.trim()
    if (id.length === 0) return
    onChange(setOption(target, id, rawValue))
    setRawId("")
    setRawValue("")
  }

  // Options the config holds that no descriptor accounted for. Shown rather
  // than hidden: a value in the file the UI does not draw is a value the user
  // cannot clear. While the catalogue is still loading this is every option
  // they have, which is the right answer — better a raw row they can edit than
  // a card that hides their settings behind a spinner.
  const undescribed = targetOptions(target).filter(
    (option) => !descriptors.some((descriptor) => descriptor.id === option.id),
  )

  return (
    <div className="space-y-4 border-t border-border/70 pt-3">
      <p className="text-[13px] leading-[1.45] text-muted-foreground/85">{verdict.sentence}</p>
      {verdict.reloadSentence !== undefined ? (
        <p className="text-[13px] leading-[1.45] text-muted-foreground/85">{verdict.reloadSentence}</p>
      ) : null}
      {verdict.warnings.map((warning) => (
        <p key={warning} role="status" className="text-[13px] leading-[1.45] text-warning-foreground">
          {warning}
        </p>
      ))}

      {derived ? (
        <p className="text-[13px] leading-[1.45] text-muted-foreground/85">
          This target is Observer reading your older <code className="font-mono text-[11px]">model</code> and{" "}
          <code className="font-mono text-[11px]">variant</code> fields. Editing anything here rewrites the seat in
          target form and those two fields go away.
        </p>
      ) : null}

      {issues.length > 0 ? (
        <ul className="space-y-1.5">
          {issues.map((issue) => (
            <li key={`${issue.code}:${issue.path}`}>
              <Badge variant={badgeVariant(issue.severity)} className="w-full items-start whitespace-normal text-left">
                {issue.message}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="flex items-center gap-2 text-[13px] font-medium text-foreground">
            Model
            {ready !== undefined && ready.models.length > 0 ? (
              <Badge variant="outline" size="sm">
                {freshnessLabel(ready.freshness)}
              </Badge>
            ) : null}
          </h4>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Rescan ${label}'s model list`}
            disabled={catalogue.status === "loading" || host.length === 0}
            onClick={() => void catalogue.refresh()}
          >
            <RefreshCwIcon className={cn(catalogue.status === "loading" && "animate-spin")} />
          </Button>
        </div>

        {/*
          A slow CLI gets a sentence, not a frozen card. Everything below stays
          interactive while this is up: the free-text model field, the raw
          option rows and Clear target all work without a catalogue.
        */}
        {catalogue.status === "idle" || catalogue.status === "loading" ? (
          <p role="status" className="text-xs text-muted-foreground">
            Reading {label}'s model list. This can take a few seconds — Observer asks the host itself, and a host that
            is not installed takes the longest to say so.
          </p>
        ) : null}

        {catalogue.status === "error" ? (
          <p role="alert" className="text-xs text-error-foreground">
            Observer could not reach {label}'s model list: {catalogue.error}. You can still type a model id below.
          </p>
        ) : null}

        {ready !== undefined && ready.models.length > 0 ? (
          <>
            <Input
              inputSize="sm"
              type="search"
              value={filter}
              placeholder="Filter models"
              aria-label={`Filter ${targetTitle(directory, targetId, host)} models`}
              onChange={(event) => setFilter(event.currentTarget.value)}
            />
            <Select
              value={model ?? UNSET}
              options={modelOptions(catalogue, model, filter)}
              ariaLabel={`${targetTitle(directory, targetId, host)} model`}
              placeholder="Inherit the session's model"
              onValueChange={(value) => chooseModel(value === UNSET ? undefined : value)}
            />
          </>
        ) : null}

        {catalogueEntry !== undefined && context !== undefined ? (
          <p className="text-xs text-muted-foreground">{context} context</p>
        ) : null}

        {profileNote !== undefined ? (
          <p role="status" className="text-xs text-warning-foreground">
            {profileNote}
          </p>
        ) : null}

        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Input
              inputSize="sm"
              value={typed}
              placeholder={host === "opencode" ? "provider/model" : "model id, as this host writes it"}
              aria-label={`Type a ${targetTitle(directory, targetId, host)} model id`}
              aria-invalid={typedProblem !== undefined}
              onChange={(event) => setTyped(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitTyped()
              }}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={typed.trim().length === 0 || typedProblem !== undefined}
            onClick={commitTyped}
          >
            Use
          </Button>
        </div>
        {typedProblem !== undefined ? (
          <p role="alert" className="text-xs text-error-foreground">
            {typedProblem}
          </p>
        ) : ready !== undefined ? (
          // The daemon's own sentence about a missing binary or an empty list,
          // verbatim. A host that is not installed is a healthy 200 here, so
          // this is information, not an error.
          <p className="text-xs text-muted-foreground/80">{catalogueNote(ready)}</p>
        ) : null}
      </section>

      <section className="space-y-1">
        <h4 className="text-[13px] font-medium text-foreground">Options</h4>
        {descriptors.map((descriptor) => (
          <OptionField
            key={descriptor.id}
            descriptor={descriptor}
            value={optionValue(target, descriptor.id)}
            onChange={(value) => onChange(setOption(target, descriptor.id, value))}
          />
        ))}
        {note !== undefined ? <p className="pt-1 text-xs text-muted-foreground/80">{note}</p> : null}

        {undescribed.length > 0 ? (
          <ul className="space-y-1 pt-2">
            {undescribed.map((option) => (
              <li
                key={option.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/70 px-2 py-1.5"
              >
                <span className="min-w-0 truncate font-mono text-[11px] text-foreground">
                  {option.id} = {typeof option.value === "boolean" ? String(option.value) : option.value}
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Remove option ${option.id}`}
                  onClick={() => onChange(setOption(target, option.id, undefined))}
                >
                  <Trash2Icon />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {/*
          The escape hatch, and the honest one. Where a host describes no knobs
          Observer can vouch for — an empty `options: []`, a CLI that is not
          installed, a model the list has never seen — the answer is to let the
          user write the host's own id and value, not to draw a dropdown filled
          with another host's ladder and hope it fits.
        */}
        <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center">
          <div className="w-full sm:w-44">
            <Input
              inputSize="sm"
              value={rawId}
              placeholder="option id"
              aria-label={`New option id for ${targetTitle(directory, targetId, host)}`}
              onChange={(event) => setRawId(event.currentTarget.value)}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Input
              inputSize="sm"
              value={rawValue}
              placeholder="value"
              aria-label={`New option value for ${targetTitle(directory, targetId, host)}`}
              onChange={(event) => setRawValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitRaw()
              }}
            />
          </div>
          <Button size="sm" variant="outline" disabled={rawId.trim().length === 0} onClick={commitRaw}>
            <PlusIcon />
            Add
          </Button>
        </div>
      </section>

      <div className="flex justify-end pt-1">
        <Button
          size="sm"
          variant="destructive-outline"
          onClick={onClear}
          aria-label={`Clear the ${targetTitle(directory, targetId, host)} target`}
        >
          <Trash2Icon />
          Clear target
        </Button>
      </div>
    </div>
  )
}

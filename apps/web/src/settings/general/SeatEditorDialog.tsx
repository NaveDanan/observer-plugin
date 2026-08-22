/**
 * The seat editor: one employee's model, reasoning effort and skills.
 *
 * A dialog rather than an inline expander. The grid is fifteen cards deep and
 * expanding one in place would reflow every card after it and push the Capture
 * section a screen and a half down — and the editor needs a filter box, two
 * pickers and a list, which is more than a settings row's control column can
 * hold. The dialog also inherits the page's Escape contract: `SettingsPage`
 * already declines to close the page while a `[role="dialog"]` is mounted.
 *
 * There is no Save button, and that is the one thing here that is not a
 * translation of `observer config`. A terminal UI had to batch writes behind
 * `s` because it had nowhere to put an autosave; this surface writes through
 * the shared optimistic `save()` on every commit, and adopts the daemon's
 * normalised answer — which is how a bare skill name typed here comes back as
 * `{ name, description }` without the user doing anything.
 */

import { useState } from "react"
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import type { RosterProfile } from "@observer-ai/roster"
import type { ModelInfo, SeatIssue, SeatSkill, SeatSpec } from "../../api"
import {
  Badge,
  Button,
  Dialog,
  DraftInput,
  Input,
  Select,
} from "../../ui/primitives"
import { cn } from "../../lib/utils"
import {
  UNSET,
  badgeVariant,
  effortChoice,
  formatContext,
  malformedModelMessage,
  modelOptions,
  patchSeat,
  seatModel,
  seatPreview,
  seatSkills,
  seatVariant,
} from "./seat"

export interface SeatEditorDialogProps {
  profile: RosterProfile
  /** The seat as the daemon last returned it, or undefined for no seat. */
  spec: SeatSpec | undefined
  control: boolean
  /** `diagnoseSeats`' findings for this employee, rendered verbatim. */
  issues: ReadonlyArray<SeatIssue>
  models: ReadonlyArray<ModelInfo>
  modelsError: string | undefined
  probing: boolean
  saving: boolean
  onRefreshModels: () => void
  /** A complete replacement spec; an empty one clears the seat. */
  onChange: (next: SeatSpec) => void
  onClear: () => void
  onClose: () => void
}

export function SeatEditorDialog(props: SeatEditorDialogProps): JSX.Element {
  const { profile, spec, control, issues, models, modelsError, probing, saving } = props
  const [filter, setFilter] = useState("")
  const [typed, setTyped] = useState("")
  const [newSkill, setNewSkill] = useState<SeatSkill>({ name: "", description: "" })
  /** Set when a name edit was refused, so the field does not just snap back. */
  const [nameRefused, setNameRefused] = useState(false)

  const model = seatModel(spec)
  const variant = seatVariant(spec)
  const skills = seatSkills(spec)
  const catalogueEntry = models.find((entry) => entry.id === model)
  const context = formatContext(catalogueEntry?.contextWindow)
  const effort = effortChoice(model, catalogueEntry?.variants, variant)
  // Live, because a half-typed id has no server answer to wait for. A real
  // `malformed-model` finding from the daemon still renders above, verbatim.
  const typedProblem = malformedModelMessage(typed.trim())

  const commitTyped = (): void => {
    const next = typed.trim()
    if (next.length === 0 || typedProblem !== undefined) return
    props.onChange(patchSeat(spec, { model: next }))
    setTyped("")
  }

  const commitSkills = (next: SeatSkill[]): void => {
    setNameRefused(false)
    props.onChange(patchSeat(spec, { skills: next }))
  }

  return (
    <Dialog
      open
      onClose={props.onClose}
      className="max-w-2xl"
      title={
        <span className="flex items-center gap-2">
          {profile.fullName}
          {saving ? <span className="text-xs font-normal text-muted-foreground">saving…</span> : null}
        </span>
      }
      description={profile.title}
      footer={
        <>
          <Button
            variant="destructive-outline"
            size="sm"
            disabled={spec === undefined}
            onClick={props.onClear}
          >
            <Trash2Icon />
            Clear seat
          </Button>
          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={props.onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="space-y-6 pb-2">
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

        <Field
          title="Model"
          description="What this employee should run. Left unset, they inherit whatever model the session is already running."
          action={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Rescan the model catalogue"
              disabled={probing}
              onClick={props.onRefreshModels}
            >
              <RefreshCwIcon className={cn(probing && "animate-spin")} />
            </Button>
          }
        >
          <div className="space-y-2">
            <Input
              inputSize="sm"
              type="search"
              value={filter}
              placeholder="Filter models"
              aria-label="Filter models"
              onChange={(event) => setFilter(event.currentTarget.value)}
            />
            <Select
              value={model ?? UNSET}
              options={modelOptions(models, model, filter)}
              onValueChange={(value) => props.onChange(patchSeat(spec, { model: value }))}
              ariaLabel="Model"
              placeholder="Inherit the session's model"
            />
            {catalogueEntry !== undefined ? (
              <p className="text-xs text-muted-foreground">
                {catalogueEntry.providerLabel}
                {context !== undefined ? ` · ${context} context` : ""}
                {catalogueEntry.known ? "" : " · the host lists this model but Observer's catalogue has no entry for it"}
              </p>
            ) : model !== undefined ? (
              <p className="text-xs text-muted-foreground">
                Not in the catalogue Observer read. That is only a gap in what Observer knows — the host is the
                authority on which models exist.
              </p>
            ) : null}

            <div className="flex items-start gap-2 pt-1">
              <div className="min-w-0 flex-1">
                <Input
                  inputSize="sm"
                  value={typed}
                  placeholder="provider/model"
                  aria-label="Type a model id"
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
            ) : (
              <p className="text-xs text-muted-foreground/80">
                {models.length === 0
                  ? modelsError ??
                    "No model catalogue on this machine, so the list above is empty. Run OpenCode once to populate it, or type an id here."
                  : "Anything the catalogue has not heard of, written provider/model."}
              </p>
            )}
          </div>
        </Field>

        <Field
          title="Reasoning effort"
          description="Stored as the host's own name for it, variant. OpenCode applies it only to the model this seat sets."
        >
          <div className="space-y-2">
            <Select
              value={variant ?? UNSET}
              options={effort.options}
              disabled={effort.disabled}
              onValueChange={(value) => props.onChange(patchSeat(spec, { variant: value }))}
              ariaLabel="Reasoning effort"
              placeholder="No effort"
            />
            {effort.note !== undefined ? <p className="text-xs text-muted-foreground">{effort.note}</p> : null}
          </div>
        </Field>

        <Field
          title="Skills"
          description="Prompt text folded into this employee's behaviour directive. Skills are not gated on seat control: they cannot point the host at an agent that does not exist, so they apply either way."
        >
          <div className="space-y-2">
            {skills.map((skill, index) => (
              <div key={`${index}:${skill.name}`} className="flex items-start gap-2">
                <div className="w-40 shrink-0">
                  <DraftInput
                    inputSize="sm"
                    value={skill.name}
                    aria-label={`Skill ${index + 1} name`}
                    onCommit={(value) => {
                      // A nameless skill is dropped by the daemon's schema, and
                      // it drops the whole `skills` array with it — so an empty
                      // name is refused here rather than saved and mourned.
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
                  onChange={(event) =>
                    setNewSkill((current) => ({ ...current, description: event.currentTarget.value }))
                  }
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
          </div>
        </Field>

        <div className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">In effect</p>
          <p className="pt-0.5 text-[13px] leading-[1.45] text-foreground">
            {seatPreview(spec, control, profile.fullName)}
          </p>
        </div>
      </div>
    </Dialog>
  )
}

function Field({
  title,
  description,
  action,
  children,
}: {
  title: string
  description: string
  action?: JSX.Element
  children: JSX.Element
}): JSX.Element {
  return (
    <section className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium tracking-[-0.005em] text-foreground">{title}</h3>
          <p className="text-[13px] leading-[1.45] text-muted-foreground/80">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

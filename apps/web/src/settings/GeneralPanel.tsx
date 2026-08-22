/**
 * The General tab: employees and seat control, what Observer captures, and how
 * long it keeps it.
 *
 * The Employees section is a replacement for `observer config`'s terminal
 * screens rather than a port of them. Two things carry over deliberately —
 * every finding is the daemon's own sentence, rendered verbatim, and seat
 * control's state is never out of sight of the models it governs — because
 * both exist to stop the UI claiming an employee "runs Opus" when the flag
 * that would make that true is off.
 *
 * Every write goes through `patch`, which rebuilds the object it is sending
 * from the freshest config it can reach. `PUT /v1/config` replaces `seats`,
 * `capture` and `redaction` wholesale, so a handler that closed over the
 * config it rendered with would silently revert whatever landed in between.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { EyeIcon, SearchIcon, ShieldIcon, UsersIcon } from "lucide-react"
import type { RosterProfile } from "@observer-ai/roster"
import type { CaptureConfig, ConfigPatch, ObserverConfigView, SeatSpec } from "../api"
import {
  Badge,
  Button,
  Input,
  NumberField,
  Select,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  Switch,
} from "../ui/primitives"
import { useObserverConfig } from "./useConfig"
import { useCatalogue } from "./general/catalogue"
import { EmployeeGrid, matchesQuery } from "./general/EmployeeGrid"
import { SeatEditorDialog } from "./general/SeatEditorDialog"
import { isEmptySeat, isSeated, issuesFor } from "./general/seat"

/**
 * Mirrors `DEFAULT_CONFIG` in `apps/daemon/src/config.ts`, which is the
 * authority. Copied for one purpose — deciding whether a reset button has
 * anything to reset — so a drift here shows a spare button, never a wrong
 * value: the daemon re-validates everything this panel sends.
 */
const DEFAULT_CAPTURE: CaptureConfig = {
  messages: true,
  reasoning: false,
  toolInput: true,
  toolOutput: true,
  prompts: true,
  rawEvents: false,
}
const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_MAX_TEXT_LENGTH = 64_000
const DEFAULT_REDACTION_ENABLED = true
const DEFAULT_GUIDANCE = true

export function GeneralPanel(): JSX.Element {
  const { config, loading, error, saving, save } = useObserverConfig()
  const catalogue = useCatalogue()
  const [query, setQuery] = useState("")
  const [editing, setEditing] = useState<string | undefined>(undefined)

  /**
   * The newest config any render has seen, readable from an event handler.
   *
   * Written in an effect rather than during render: React commits effects
   * before it dispatches the next user event, so the handler always reads the
   * snapshot the user was actually looking at, and a render that is thrown
   * away never gets to poison it.
   */
  const latest = useRef<ObserverConfigView | undefined>(config)
  useEffect(() => {
    latest.current = config
  }, [config])

  /**
   * Sends a patch built from the latest config, never from this render's copy.
   *
   * The seats case is the one that bites: `employees` is a record the daemon
   * replaces whole, so rebuilding it from a stale closure would drop a skill
   * someone added to a different employee thirty seconds ago in another tab.
   */
  const patch = useCallback(
    (build: (current: ObserverConfigView) => ConfigPatch): void => {
      const current = latest.current
      if (current === undefined) return
      void save(build(current))
    },
    [save],
  )

  const profiles = catalogue.profiles
  const filtered = useMemo(() => profiles.filter((profile) => matchesQuery(profile, query)), [profiles, query])

  if (config === undefined) {
    return (
      <p role="status" className="px-4 py-12 text-center text-sm text-muted-foreground">
        {loading ? "Loading settings…" : (error ?? "Settings are unavailable: the daemon did not answer.")}
      </p>
    )
  }

  const seats = config.seats
  const issues = config.diagnosis.issues
  const controlDisabled = issues.find((issue) => issue.code === "control-disabled")
  const unknownEmployees = issues.filter((issue) => issue.code === "unknown-employee")
  const seatedCount = profiles.filter((profile) => isSeated(seats.employees[profile.id])).length
  const editingProfile = profiles.find((profile) => profile.id === editing)

  const setCapture = (key: keyof CaptureConfig, value: boolean): void =>
    patch((current) => ({ capture: { ...current.capture, [key]: value } }))

  const openSeat = (profile: RosterProfile): void => setEditing(profile.id)

  /** Replaces one employee's entry, keeping every other seat as last seen. */
  const replaceSeat = (employeeId: string, spec: SeatSpec | undefined): void =>
    patch((current) => {
      const employees = { ...current.seats.employees }
      if (spec === undefined || isEmptySeat(spec)) delete employees[employeeId]
      else employees[employeeId] = spec
      return { seats: { control: current.seats.control, employees } }
    })

  /** Re-keys a seat whose id matches nobody, without disturbing the others. */
  const moveSeat = (from: string, to: string): void =>
    patch((current) => {
      const employees = { ...current.seats.employees }
      const spec = employees[from]
      if (spec === undefined) return { seats: current.seats }
      delete employees[from]
      employees[to] = spec
      return { seats: { control: current.seats.control, employees } }
    })

  return (
    <>
      {error !== undefined ? (
        <p role="alert" className="mx-3 rounded-lg bg-error-surface px-3 py-2 text-[13px] text-error-foreground sm:mx-4">
          {error}
        </p>
      ) : null}

      <SettingsSection
        title="Employees"
        icon={<UsersIcon className="size-4.5 text-muted-foreground" />}
        headerAction={
          <span className="text-xs text-muted-foreground">
            {profiles.length === 0 ? "roster unavailable" : `${seatedCount} of ${profiles.length} seated`}
          </span>
        }
      >
        <SettingsRow
          id="setting-seat-control"
          title="Seat control"
          description="Opt-in, and off by default. With it on, Observer generates hidden per-employee OpenCode agent definitions and rewrites the host's subagent_type, so a seat's model and effort are what your delegations actually run. With it off, model and effort are inert and Observer only observes. Skills are not gated on it: they are prompt text folded into the behaviour directive, so they apply either way."
          resetAction={
            seats.control ? (
              <SettingResetButton
                label="seat control"
                onClick={() => patch((current) => ({ seats: { control: false, employees: current.seats.employees } }))}
              />
            ) : null
          }
          status={
            controlDisabled !== undefined ? (
              <Badge variant="secondary" className="items-start whitespace-normal text-left">
                {controlDisabled.message}
              </Badge>
            ) : null
          }
          control={
            <Switch
              checked={seats.control}
              aria-label="Seat control"
              onCheckedChange={(checked) =>
                patch((current) => ({ seats: { control: checked, employees: current.seats.employees } }))
              }
            />
          }
        />

        <SettingsRow
          id="setting-employees"
          title="Seats"
          description="A seat spec says what an employee should run: a model, a reasoning effort and skills. Every field is optional, and an omitted model means they inherit whatever model the session is already running. Open a card to edit one."
          control={
            <div className="flex w-full items-center gap-2 sm:w-56">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
              <Input
                type="search"
                inputSize="sm"
                value={query}
                placeholder="Search employees"
                aria-label="Search employees"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
          }
        >
          {catalogue.rosterError !== undefined ? (
            <p role="alert" className="py-4 text-[13px] text-error-foreground">
              The roster did not load, so there is nobody to seat: {catalogue.rosterError}
            </p>
          ) : catalogue.loading ? (
            <p role="status" className="py-4 text-[13px] text-muted-foreground">
              Loading the roster…
            </p>
          ) : (
            <EmployeeGrid profiles={filtered} employees={seats.employees} issues={issues} onOpen={openSeat} />
          )}
        </SettingsRow>

        {unknownEmployees.length > 0 ? (
          <SettingsRow
            id="setting-unknown-seats"
            title="Seats with no employee"
            description="These ids are in your config but match nobody on the roster, so nothing uses them. They are kept on disk so a typo can be corrected rather than quietly lost."
          >
            <ul className="space-y-2 py-2">
              {unknownEmployees.map((issue) => {
                const badId = issue.employeeId ?? ""
                return (
                  <li
                    key={issue.path}
                    className="flex flex-col gap-2 rounded-lg border border-border/70 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="font-mono text-xs text-foreground">{badId}</p>
                      <p className="text-[13px] leading-[1.45] text-error-foreground">{issue.message}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <div className="w-48">
                        <Select
                          value={undefined}
                          placeholder="Move to…"
                          ariaLabel={`Move the seat "${badId}" to an employee`}
                          options={profiles.map((profile) => ({
                            value: profile.id,
                            label: profile.fullName,
                            disabled: seats.employees[profile.id] !== undefined,
                          }))}
                          onValueChange={(target) => moveSeat(badId, target)}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="destructive-outline"
                        onClick={() => replaceSeat(badId, undefined)}
                        aria-label={`Delete the seat "${badId}"`}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </SettingsRow>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Capture" icon={<EyeIcon className="size-4.5 text-muted-foreground" />}>
        <CaptureRow
          id="setting-capture-messages"
          title="Messages"
          description="What the agents said: prompts you sent and the text they sent back. Turning this off means message text is never written to disk, not that it is hidden — the canvas keeps its shape, and the transcript is simply not there."
          field="messages"
          capture={config.capture}
          onChange={setCapture}
        />
        <CaptureRow
          id="setting-capture-reasoning"
          title="Reasoning"
          description="Chain-of-thought blocks, as the host emits them. Off by default because raw reasoning is the most sensitive and least useful content to keep on disk: it is where a model thinks out loud about the secrets it was just shown. Off means it is never written to disk."
          field="reasoning"
          capture={config.capture}
          onChange={setCapture}
        />
        <SettingsRow
          id="setting-capture-tools"
          title="Tool calls"
          description="Arguments in, results out. Tool input carries file paths and command lines; tool output carries whatever the tool read, which is where a repository's contents end up. Either switch off means that half is never written to disk."
          resetAction={
            config.capture.toolInput !== DEFAULT_CAPTURE.toolInput ||
            config.capture.toolOutput !== DEFAULT_CAPTURE.toolOutput ? (
              <SettingResetButton
                label="tool capture"
                onClick={() =>
                  patch((current) => ({
                    capture: {
                      ...current.capture,
                      toolInput: DEFAULT_CAPTURE.toolInput,
                      toolOutput: DEFAULT_CAPTURE.toolOutput,
                    },
                  }))
                }
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                Input
                <Switch
                  checked={config.capture.toolInput}
                  aria-label="Capture tool input"
                  onCheckedChange={(checked) => setCapture("toolInput", checked)}
                />
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                Output
                <Switch
                  checked={config.capture.toolOutput}
                  aria-label="Capture tool output"
                  onCheckedChange={(checked) => setCapture("toolOutput", checked)}
                />
              </span>
            </div>
          }
        />
        <CaptureRow
          id="setting-capture-prompts"
          title="Prompts"
          description="System prompts and the behaviour directives Observer hands the host, stored per agent. Useful for answering why an employee behaved the way they did; off means they are never written to disk."
          field="prompts"
          capture={config.capture}
          onChange={setCapture}
        />
        <CaptureRow
          id="setting-capture-raw"
          title="Raw events"
          description="Every event payload exactly as the host sent it, kept beside the normalised copy. Off by default: it roughly doubles what a session costs on disk and it is only worth it while you are debugging an adapter."
          field="rawEvents"
          capture={config.capture}
          onChange={setCapture}
        />
      </SettingsSection>

      <SettingsSection title="Privacy and retention" icon={<ShieldIcon className="size-4.5 text-muted-foreground" />}>
        <SettingsRow
          id="setting-redaction"
          title="Redaction"
          description="Strips credential-shaped strings out of captured text before it is stored, and truncates anything longer than the limit below. It runs on the way in, so what it removes was never on disk in the first place."
          resetAction={
            config.redaction.enabled !== DEFAULT_REDACTION_ENABLED ? (
              <SettingResetButton
                label="redaction"
                onClick={() =>
                  patch((current) => ({
                    redaction: { ...current.redaction, enabled: DEFAULT_REDACTION_ENABLED },
                  }))
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={config.redaction.enabled}
              aria-label="Redaction"
              onCheckedChange={(checked) =>
                patch((current) => ({ redaction: { ...current.redaction, enabled: checked } }))
              }
            />
          }
        />
        {config.redaction.enabled ? (
          <SettingsRow
            title="Maximum text length"
            description="Longer captured text is cut at this many characters. A transcript is evidence, not a backup: the tail of a 40,000-line file read is rarely what you came back for."
            resetAction={
              config.redaction.maxTextLength !== DEFAULT_MAX_TEXT_LENGTH ? (
                <SettingResetButton
                  label="maximum text length"
                  onClick={() =>
                    patch((current) => ({
                      redaction: { ...current.redaction, maxTextLength: DEFAULT_MAX_TEXT_LENGTH },
                    }))
                  }
                />
              ) : null
            }
            control={
              <NumberField
                value={config.redaction.maxTextLength}
                min={0}
                max={1_000_000}
                step={1000}
                suffix="characters"
                ariaLabel="Maximum text length"
                onValueChange={(value) =>
                  patch((current) => ({ redaction: { ...current.redaction, maxTextLength: value } }))
                }
              />
            }
          />
        ) : null}

        <SettingsRow
          id="setting-retention"
          title="Retention"
          description="Sessions older than this are deleted on the daemon's maintenance sweep, so a change here takes effect on the next sweep rather than the moment you set it. Zero keeps everything, forever."
          resetAction={
            config.retentionDays !== DEFAULT_RETENTION_DAYS ? (
              <SettingResetButton
                label="retention"
                onClick={() => patch(() => ({ retentionDays: DEFAULT_RETENTION_DAYS }))}
              />
            ) : null
          }
          control={
            <NumberField
              value={config.retentionDays}
              min={0}
              max={3650}
              suffix={config.retentionDays === 0 ? "days — keep everything" : "days"}
              ariaLabel="Retention in days"
              onValueChange={(value) => patch(() => ({ retentionDays: value }))}
            />
          }
        />

        <SettingsRow
          id="setting-guidance"
          title="Roster guidance"
          description="Whether the OpenCode plugin offers the roster to the root agent, so it can pick an employee for a delegation by name. Off, the roster still labels and briefs whoever the matcher seats — the root agent is simply never told the cast list."
          resetAction={
            config.guidance !== DEFAULT_GUIDANCE ? (
              <SettingResetButton label="roster guidance" onClick={() => patch(() => ({ guidance: DEFAULT_GUIDANCE }))} />
            ) : null
          }
          control={
            <Switch
              checked={config.guidance}
              aria-label="Roster guidance"
              onCheckedChange={(checked) => patch(() => ({ guidance: checked }))}
            />
          }
        />
      </SettingsSection>

      {editingProfile !== undefined ? (
        <SeatEditorDialog
          profile={editingProfile}
          spec={seats.employees[editingProfile.id]}
          control={seats.control}
          issues={issuesFor(issues, editingProfile.id)}
          models={catalogue.models}
          modelsError={catalogue.modelsError}
          probing={catalogue.probing}
          saving={saving}
          onRefreshModels={() => void catalogue.refreshModels()}
          onChange={(next) => replaceSeat(editingProfile.id, next)}
          onClear={() => replaceSeat(editingProfile.id, undefined)}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </>
  )
}

function CaptureRow({
  id,
  title,
  description,
  field,
  capture,
  onChange,
}: {
  id: string
  title: string
  description: string
  field: keyof CaptureConfig
  capture: CaptureConfig
  onChange: (field: keyof CaptureConfig, value: boolean) => void
}): JSX.Element {
  return (
    <SettingsRow
      id={id}
      title={title}
      description={description}
      resetAction={
        capture[field] !== DEFAULT_CAPTURE[field] ? (
          <SettingResetButton label={title.toLowerCase()} onClick={() => onChange(field, DEFAULT_CAPTURE[field])} />
        ) : null
      }
      control={
        <Switch
          checked={capture[field]}
          aria-label={`Capture ${title.toLowerCase()}`}
          onCheckedChange={(checked) => onChange(field, checked)}
        />
      }
    />
  )
}

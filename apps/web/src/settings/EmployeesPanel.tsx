/**
 * The Employees tab: who Observer seats, on which host, running what.
 *
 * ## Why this is a tab and not a section of General
 *
 * It used to be two rows inside General. That was the right size when a seat
 * was one model plus one reasoning effort; it is the wrong size now that a seat
 * is fourteen people times five hosts times a variable stack of adapter-supplied
 * options. General is about what Observer records and how long it keeps it —
 * capture, redaction, retention — and the answer to every one of those rows is
 * a switch. This surface asks the user to make a judgement, per person, about a
 * host whose capabilities differ from its neighbour's. Sharing a scroll with
 * five toggles buried it, and `search.ts` now routes `setting-employees` and
 * `setting-seat-control` here.
 *
 * ## The two things this screen must never do
 *
 *  - **Overstate.** Every target carries its own control status from the
 *    adapter's `capabilities()`, computed in `status.ts` and rendered
 *    identically on the card, the row and the editor. Only OpenCode reaches
 *    "applied", and only with seat control on.
 *  - **Hide anyone.** The list is a map over the roster, not over the config.
 *    See `roster.ts`.
 *
 * Every write goes through `patch`, which rebuilds what it sends from the
 * freshest config it can reach. `PUT /v1/config` replaces `seats` wholesale, so
 * a handler that closed over the config it rendered with would silently revert
 * whatever landed in between — from another tab, or from the user's own editor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { RefreshCwIcon, SearchIcon, UsersIcon } from "lucide-react"
import type { ConfigPatch, ObserverConfigView, SeatIssue, SeatSpec } from "../api"
import {
  Badge,
  Button,
  Input,
  Select,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  Switch,
} from "../ui/primitives"
import { cn } from "../lib/utils"
import { useObserverConfig } from "./useConfig"
import { useHostDirectory } from "./employees/hosts"
import { useRoster } from "./employees/useRoster"
import { EmployeeDialog } from "./employees/EmployeeDialog"
import { EmployeeRoster } from "./employees/EmployeeRoster"
import { employeeRows, matchesQuery } from "./employees/roster"
import { isEmptySeat } from "./employees/seat"

/**
 * Stable, so a render before the config arrives does not invalidate the row
 * memo with a fresh empty array every frame.
 */
const NO_ISSUES: ReadonlyArray<SeatIssue> = []

export function EmployeesPanel(): JSX.Element {
  const { config, loading, error, saving, save } = useObserverConfig()
  const roster = useRoster()
  /**
   * `GET /v1/hosts` is spawn-free by construction — the daemon calls only
   * `profiles()` and `capabilities()` — so it is safe to fetch the moment this
   * tab mounts. The catalogues, which can start a process, are fetched per
   * expanded target instead. See `employees/hosts.ts`.
   */
  const directory = useHostDirectory()
  const [query, setQuery] = useState("")
  const [editing, setEditing] = useState<string | undefined>(undefined)

  /**
   * The newest config any render has seen, readable from an event handler.
   *
   * Written in an effect rather than during render: React commits effects
   * before it dispatches the next user event, so the handler always reads the
   * snapshot the user was actually looking at, and a render that is thrown away
   * never gets to poison it.
   */
  const latest = useRef<ObserverConfigView | undefined>(config)
  useEffect(() => {
    latest.current = config
  }, [config])

  const patch = useCallback(
    (build: (current: ObserverConfigView) => ConfigPatch): void => {
      const current = latest.current
      if (current === undefined) return
      void save(build(current))
    },
    [save],
  )

  const seats = config?.seats
  const issues = config?.diagnosis.issues ?? NO_ISSUES
  const rows = useMemo(
    () => (seats === undefined ? [] : employeeRows(roster.profiles, seats, issues)),
    [roster.profiles, seats, issues],
  )
  const visible = useMemo(() => rows.filter((row) => matchesQuery(row.profile, query)), [rows, query])

  if (config === undefined || seats === undefined) {
    return (
      <p role="status" className="px-4 py-12 text-center text-sm text-muted-foreground">
        {loading ? "Loading settings…" : (error ?? "Settings are unavailable: the daemon did not answer.")}
      </p>
    )
  }

  const controlDisabled = issues.find((issue) => issue.code === "control-disabled")
  /**
   * Hosts whose `capabilities` came back null.
   *
   * The daemon returns null rather than a fabricated all-`unsupported` block
   * when an adapter throws, because "no adapter could answer" and "an adapter
   * looked and the host cannot do it" are different facts. Surfacing them here
   * keeps that distinction visible at the top of the page instead of only
   * inside a target card somebody may never open.
   */
  const degradedHosts = directory.hosts.filter((host) => host.capabilities === null)
  const unknownEmployees = issues.filter((issue) => issue.code === "unknown-employee")
  const seatedCount = rows.filter((row) => row.seated).length
  const editingRow = rows.find((row) => row.id === editing)

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
            {rows.length === 0 ? "roster unavailable" : `${seatedCount} of ${rows.length} seated`}
          </span>
        }
      >
        <SettingsRow
          id="setting-seat-control"
          title="Seat control"
          description="The master consent switch, opt-in and off by default. With it on, Observer generates hidden per-employee agent definitions and rewrites the host's delegation, so a seat's model and options are what your subagents actually run — on the hosts whose adapters can do that, which today is OpenCode alone. With it off, every target is inert and Observer only observes. Skills are not gated on it: they are prompt text folded into the behaviour directive, so they apply either way."
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

        {/*
          The host list failing is not the same as an employee's seat failing,
          so it gets its own row rather than a badge on fourteen cards. Without
          it every target reads "control unknown" with no explanation anywhere
          on the page, which is the definition of a screen that looks broken.
        */}
        {directory.error !== undefined ? (
          <SettingsRow
            id="setting-host-directory"
            title="Host list unavailable"
            description="Observer could not read which hosts it can configure, so it cannot say what any target would do. Your seats are unaffected and still saved — this is only what the page can tell you about them."
            control={
              <Button size="sm" variant="outline" onClick={() => void directory.reload()} disabled={directory.loading}>
                <RefreshCwIcon className={cn(directory.loading && "animate-spin")} />
                Retry
              </Button>
            }
            status={
              <Badge variant="error" className="items-start whitespace-normal text-left">
                {directory.error}
              </Badge>
            }
          />
        ) : null}

        {degradedHosts.length > 0 ? (
          <SettingsRow
            id="setting-host-warnings"
            title="Hosts that could not answer"
            description="These adapters failed when Observer asked what they support. A target for them still saves, and Observer makes no claim about whether it is applied — which is different from knowing that it is not."
          >
            <ul className="space-y-2 py-2">
              {degradedHosts.map((host) => (
                <li key={host.id} className="rounded-lg border border-border/70 px-3 py-2">
                  <p className="text-[13px] font-medium text-foreground">{host.label}</p>
                  {host.warnings.map((warning) => (
                    <p key={warning} className="pt-0.5 text-[13px] leading-[1.45] text-warning-foreground">
                      {warning}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </SettingsRow>
        ) : null}

        <SettingsRow
          id="setting-employees"
          title="Seats"
          description="Every employee on the roster, always, whether or not they are configured. A seat gives one person a target per host — a model id in that host's own spelling, plus the options that host describes for it — and skills shared across all of them. Open a card to edit one."
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
          {roster.error !== undefined ? (
            <p role="alert" className="py-4 text-[13px] text-error-foreground">
              The roster did not load, so there is nobody to seat: {roster.error}
            </p>
          ) : roster.loading ? (
            <p role="status" className="py-4 text-[13px] text-muted-foreground">
              Loading the roster…
            </p>
          ) : (
            <EmployeeRoster
              rows={visible}
              directory={directory}
              seatControl={seats.control}
              onOpen={(employeeId) => setEditing(employeeId)}
            />
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
                          options={rows.map((row) => ({
                            value: row.id,
                            label: row.profile.fullName,
                            disabled: row.spec !== undefined,
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

      {editingRow !== undefined ? (
        <EmployeeDialog
          profile={editingRow.profile}
          spec={editingRow.spec}
          seatControl={seats.control}
          issues={editingRow.issues}
          directory={directory}
          saving={saving}
          onChange={(next) => replaceSeat(editingRow.id, next)}
          onClearSeat={() => replaceSeat(editingRow.id, undefined)}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </>
  )
}

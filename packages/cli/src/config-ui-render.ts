import {
  LEGACY_TARGET_ID,
  type ModelOptionDescriptor,
  type SeatIssue,
  type SeatSpec,
  type SeatTarget,
  type SeatsConfig,
  diagnoseSeats,
  readOpencodeTarget,
  seatTargets,
} from "@observer-ai/daemon"
import { formatContext } from "./models.js"
import { diagnoseOpencodeSeats } from "./seat-agents.js"
import {
  type ConfigUIState,
  DEFAULT_APPLY_ROWS,
  type EmployeeRow,
  type MenuRowKind,
  type PickerEntry,
  type TargetProfile,
  type TargetControl,
  type TargetRow,
  currentEmployee,
  currentTargetRow,
  defaultUnseatedIds,
  describeDefaultChoice,
  employeeRows,
  effortCycle,
  menuRows,
  pickerEntries,
  seatOf,
  targetControl,
  targetDescriptors,
  descriptorValue,
  targetOptionValue,
  targetPickerDescriptor,
  targetPickerOptionValue,
  targetRows,
  unseatedIds,
} from "./config-ui-state.js"
import { LOGO_ROWS, wordmark } from "./logo.js"
import { PLAIN_THEME, type Theme, padEnd as pad, truncate, visibleLength } from "./theme.js"
import { versionLabel } from "./version.js"

/**
 * Turns state into lines of text. Pure, and colours only what it is given a
 * theme for.
 *
 * Colour is an overlay, never a carrier: the cursor is still a `>` in a
 * gutter, a warning still says `warning:`, an armed effort is still in
 * brackets. Read the output through `col`, a screen reader or a test
 * assertion and nothing is missing — which is why `render` defaults to
 * `PLAIN_THEME` and the shell has to opt in. `NO_COLOR` is then honoured one
 * level up, once, instead of being re-decided in every view.
 *
 * Layout is three fixed bands and one scrolling one:
 *
 *   header   what is in force right now, on every screen
 *   body     the current view, which scrolls
 *   notes    the status line and whatever diagnoseSeats has to say
 *   hints    the keys that work here
 *
 * A short terminal loses rows from the body, never from the hints that say
 * how to get out of it.
 */

export interface Viewport {
  rows: number
  columns: number
  /** Omitted means plain text: no ANSI at all. */
  theme?: Theme
  /**
   * The version the banner reports. Omitted means a dev build.
   *
   * Passed in rather than imported so the renderer stays a pure function of
   * its arguments: a test asserting on the banner states the version it
   * expects instead of rendering differently under a release bundle.
   */
  version?: string
}

export const DEFAULT_VIEWPORT: Viewport = { rows: 24, columns: 100 }

/** Width of the label gutter, matching `observer status` and `observer doctor`. */
const GUTTER = 20

/**
 * The band separator.
 *
 * A box-drawing character rather than `-`, because this line is furniture and
 * should not read as content; it is one code point wide, so the column
 * arithmetic is unaffected.
 */
const RULE = "\u2500"

/**
 * The picker's glyphs.
 *
 * A single-angle quote for the cursor rather than `>`: the two read the same
 * on paper, but `>` is also the breadcrumb separator two lines above it, and
 * one character meaning two things in one screen is how a list stops looking
 * like a list. The rail, the stepper arrows and the em dash are likewise
 * chosen to be one column wide, so none of them disturbs the arithmetic.
 */
const CURSOR = "\u203A"
const TRACK = "\u2502"
const THUMB = "\u2588"
const LEFT = "\u2190"
const RIGHT = "\u2192"
const DASH = "\u2014"

/** The separator in a dotted hint bar, spaced so the keys stay the loud part. */
const DOT = " \u00B7 "

/**
 * Everything wrong with a seats config, host-agnostic findings first.
 *
 * `diagnoseSeats` no longer applies OpenCode's `provider/model` rule — it is
 * host policy, and applied to every host it failed Codex's `gpt-5.6-sol` and
 * Grok's `grok-build`. The TUI still has to say why a slashless model will not
 * work, or typing one looks like it was accepted. Merging here keeps the
 * sentence identical to the one the installer prints, which is the whole point
 * of rendering findings verbatim.
 */
function seatIssues(seats: SeatsConfig): SeatIssue[] {
  return [...diagnoseSeats(seats).issues, ...diagnoseOpencodeSeats(seats)]
}

export function render(state: ConfigUIState, viewport: Viewport = DEFAULT_VIEWPORT): string[] {
  const columns = Math.max(60, viewport.columns)
  const theme = viewport.theme ?? PLAIN_THEME
  const diagnosis = diagnoseSeats(state.seats)
  const issues = seatIssues(state.seats)
  const lines = [...header(state, diagnosis.effective, columns, theme, viewport.version)]

  const footer = [...notes(state, issues, columns, theme), "", ...hints(state, columns, theme)]
  const room = Math.max(3, viewport.rows - lines.length - footer.length - 1)

  switch (state.view) {
    case "menu":
      lines.push(...mainMenu(state, issues, columns, theme))
      break
    case "employees":
      lines.push(...employeeList(state, issues, room, columns, theme))
      break
    case "employee":
      lines.push(...employeeDetail(state, columns, theme))
      break
    case "targets":
      lines.push(...targetList(state, room, columns, theme))
      break
    case "models":
    case "default":
      lines.push(...modelPicker(state, room, columns, theme))
      break
    case "default-target":
      lines.push(...defaultTargetChooser(state, room, columns, theme))
      break
    case "apply":
      lines.push(...applyScopeChooser(state, columns, theme))
      break
    case "options":
      lines.push(...optionEditor(state, columns, theme))
      break
  }

  lines.push(...footer)
  return lines.map((line) => truncate(line, columns))
}

/**
 * The wordmark: `NJ` in pixels, beside the version and the maker.
 *
 * The mark itself lives in `logo.ts`, drawn with half-block characters so that
 * eight rows of pixels fit into four rows of terminal. Height is worth arguing
 * over because every row here is a row the model list below does not get on an
 * 80x24 terminal, which is why the detail was bought with a denser glyph
 * rather than with more rows.
 *
 * The three text lines sit on rows 0-2 of 4. They carry what the old single
 * title line carried, plus the version — a user reporting a bug should not
 * have to leave the screen they are on to find out which build drew it.
 */
function banner(version: string | undefined, theme: Theme): string[] {
  return wordmark(theme.depth, [
    theme.title(`Observer multi-harness ${versionLabel(version ?? "dev")}`),
    theme.dim("By NJ-Labs"),
    theme.dim("host targets, model options and skills per employee"),
  ])
}

/**
 * How many lines the banner occupies, for callers that need to look past it.
 *
 * Exported for the tests, which assert things about the picker below and would
 * otherwise mistake the mark's solid blocks for the scroll rail's.
 */
export const BANNER_ROWS = LOGO_ROWS

/**
 * What is in force, on every screen.
 *
 * A config UI that lets you pick a model without saying that the flag which
 * would apply it is off is a UI that lies, so these two answers are fixed
 * chrome rather than something you have to go and look for. The narrowings —
 * which host, which delegations — live on the menu row that owns the flag,
 * where there is room to say them in full.
 */
function header(
  state: ConfigUIState,
  effective: boolean,
  columns: number,
  theme: Theme,
  version?: string,
): string[] {
  const control = state.seats.control
  const lines = [
    ...banner(version, theme),
    "",
    ...field(
      "Seat control",
      control ? "on - Observer sets the model and effort" : "off - model and effort are inert; skills still apply",
      control ? theme.good : theme.warn,
      columns,
      theme,
    ),
    ...field(
      "Right now",
      effective ? "this config changes what runs" : "this config changes nothing",
      effective ? theme.good : theme.dim,
      columns,
      theme,
    ),
    state.dirty ? theme.dim(pad("Unsaved changes", GUTTER)) + theme.warn("press s to write them to config.json") : "",
    theme.dim(RULE.repeat(Math.max(0, columns))),
  ]
  return lines
}

/**
 * One `label   value` row, wrapped into the gutter instead of clipped.
 *
 * The value arrives as plain text with its style beside it rather than
 * pre-painted, so the wrap is computed on what the user can actually see: a
 * colour code is not a character, and letting one push a word onto the next
 * line would make the layout depend on whether colour happened to be on.
 *
 * The alternative to wrapping is truncation, and truncating this particular
 * column loses the end of sentences that exist to be read in full — "...keeps
 * its own prompt, tools and mo..." is worse than two lines.
 */
function field(
  label: string,
  value: string,
  style: (text: string) => string,
  columns: number,
  theme: Theme,
): string[] {
  const wrapped = wrapAt(value, Math.max(24, columns - GUTTER), "").split("\n")
  return wrapped.map((line, index) =>
    index === 0 ? theme.dim(pad(label, GUTTER)) + style(line) : " ".repeat(GUTTER) + style(line),
  )
}

/**
 * The top level.
 *
 * Rows carry their own state in the value column, so "what is seat control
 * doing" is answered by looking at it rather than by pressing it. The row
 * under the cursor expands with the detail that would otherwise be permanent
 * chrome — the two narrowings on seat control are the whole reason the row
 * exists, and they are too long to sit on every screen.
 */
function mainMenu(state: ConfigUIState, issues: SeatIssue[], columns: number, theme: Theme): string[] {
  const rows = menuRows(state)
  const at = Math.min(state.cursor.menu, rows.length - 1)
  const seated = Object.keys(state.seats.employees).length
  const errors = issues.filter((issue) => issue.severity === "error").length

  const labels: Record<MenuRowKind, string> = {
    control: "Seat control",
    employees: "Employees",
    "default-model": "Default model",
    save: "Save & exit",
    exit: "Exit",
  }
  const unseated = unseatedIds(state).length
  const values: Record<MenuRowKind, string> = {
    control: state.seats.control ? theme.good("on") : theme.warn("off"),
    employees: `${state.roster.length} people, ${seated === 0 ? "none seated" : `${seated} seated`}${
      errors > 0 ? theme.alert(`, ${errors} to fix`) : ""
    }`,
    "default-model": theme.dim(`hand one model to ${unseated === state.roster.length ? "everyone" : `${unseated} unseated`} at once`),
    save: theme.warn("write these seats to config.json"),
    exit: theme.dim("leave observer config"),
  }
  const details: Record<MenuRowKind, string[]> = {
    control:
      state.profiles.length === 0
        ? [
            "OpenCode and Copilot CLI can apply seat control",
            "Only neutral delegations are redirected - specialist agents keep their prompt, tools and model",
          ]
        : [
            "OpenCode and Copilot CLI targets are applied; Codex and Claude Code targets are recorded only",
            "Each target says whether it is applied, experimental, configured, or not applied to children",
            "Only neutral delegations are redirected - specialist agents keep their prompt, tools and model",
          ],
    employees: ["Give a person one target per host/profile, plus shared skills."],
    "default-model": [
      state.profiles.length > 0
        ? `Pick a host target and one of its models, then give it to the ${unseated} employee${unseated === 1 ? "" : "s"} with no model there, or move all ${state.roster.length} onto it.`
        : `Pick a model and reasoning effort once, then give it to the ${unseated} employee${unseated === 1 ? "" : "s"} with no seat, or move all ${state.roster.length} onto it.`,
    ],
    save: ["Writes seats to config.json, regenerates the agent definitions, and leaves."],
    exit: [],
  }

  const lines = [theme.heading("Main menu"), ""]
  rows.forEach((row, index) => {
    const selected = index === at
    const label = pad(labels[row] ?? row, GUTTER)
    lines.push(marker(selected, false, theme) + (selected ? theme.focus(label) : label) + values[row])
    if (!selected) return
    for (const detail of details[row]) {
      for (const line of wrapAt(detail, Math.max(24, columns - GUTTER - 2), "").split("\n")) {
        lines.push(" ".repeat(GUTTER + 2) + theme.dim(line))
      }
    }
  })

  // The one path a new user has to walk, spelled out while it is still true.
  // It disappears the moment either half of it has been done, so it never
  // becomes furniture.
  if (!state.seats.control && Object.keys(state.seats.employees).length === 0) {
    lines.push(
      "",
      theme.heading("Getting started"),
      theme.dim("  1. Turn seat control on, so the models you pick here reach OpenCode."),
      theme.dim("  2. Open Employees and give someone a model."),
      theme.dim("  3. Press s to save."),
    )
  }
  return lines
}

function employeeList(
  state: ConfigUIState,
  issues: SeatIssue[],
  room: number,
  columns: number,
  theme: Theme,
): string[] {
  const width = listWidths(columns)
  const flagged = new Set(issues.filter((issue) => issue.employeeId !== undefined).map((issue) => issue.employeeId!))
  const seated = Object.keys(state.seats.employees).length

  const lines = [
    theme.heading("Employees") + theme.dim(`   ${seated} of ${state.roster.length} seated`),
    "",
    theme.dim(
      `  ${pad("Employee", width.name)}${pad("Role", width.role)}${pad("Model", width.model)}${pad("Effort", width.effort)}${width.skills > 0 ? "Skills" : ""}`,
    ),
  ]

  const window = windowOf(state.cursor.employees, state.roster.length, room - 3)
  for (let index = window.start; index < window.end; index++) {
    const row = state.roster[index]
    if (!row) continue
    const seat = state.seats.employees[row.id]
    const configured = opencodeSeat(seat)
    const targets = seatTargets(seat)
    const targetCount = Object.keys(targets).length
    const model =
      state.profiles.length > 0
        ? targetCount === 0
          ? "no targets"
          : `${targetCount} target${targetCount === 1 ? "" : "s"}`
        : (configured?.model ?? "inherit")
    const variant = state.profiles.length > 0 ? "-" : (configured?.variant ?? "-")
    const skills = Array.isArray(seat?.skills) ? seat.skills.map((skill) => skill.name).join(", ") : ""
    const selected = index === state.cursor.employees
    const name = pad(truncate(row.name, width.name - 1), width.name)
    // A configured model is the one piece of data on the row the user put
    // there, so it is the one that takes the highlight; `inherit` is the
    // absence of a choice and reads as secondary.
    const modelCell = pad(truncate(model, width.model - 1), width.model)
    lines.push(
      marker(selected, flagged.has(row.id), theme) +
        (selected ? theme.focus(name) : name) +
        theme.dim(pad(truncate(row.role, width.role - 1), width.role)) +
        (state.profiles.length > 0 ? (targetCount > 0 ? theme.accent(modelCell) : theme.dim(modelCell)) : configured !== undefined ? theme.accent(modelCell) : theme.dim(modelCell)) +
        pad(variant, width.effort) +
        (width.skills > 0 ? theme.dim(truncate(skills.length > 0 ? skills : "-", width.skills)) : ""),
    )
  }
  if (window.end < state.roster.length || window.start > 0) {
    lines.push(theme.dim(`  ${window.start + 1}-${window.end} of ${state.roster.length}`))
  }
  return lines
}

function employeeDetail(state: ConfigUIState, columns: number, theme: Theme): string[] {
  const employee = currentEmployee(state)
  const seat = seatOf(state, state.employeeId)
  const rows = employeeRows(state)
  const configured = opencodeSeat(seat)
  const model = configured?.model ?? "inherit (the session's model)"
  const variant = configured?.variant ?? "-"
  const skills = Array.isArray(seat?.skills) ? seat.skills.map((skill) => skill.name).join(", ") : ""

  const values: Record<string, string> = {
    model: `${configured !== undefined ? theme.accent(model) : theme.dim(model)}   ${theme.dim("effort")} ${variant}`,
    targets: `${Object.keys(seatTargets(seat)).length} configured   ${theme.dim("enter to edit by host and profile")}`,
    skills: skills.length > 0 ? skills : theme.dim("none"),
    reset: theme.dim("clear this employee's targets and skills"),
  }
  const labels: Record<string, string> = {
    model: "Model",
    targets: "Targets",
    skills: "Skills",
    reset: "Reset to defaults",
  }

  const lines = [
    breadcrumb(theme, "Employees", employee?.name ?? state.employeeId ?? "employee"),
    theme.dim(`  ${employee?.role ?? ""}`),
    "",
  ]
  rows.forEach((row, index) => {
    const selected = index === state.cursor.employee
    const label = pad(labels[row] ?? row, GUTTER)
    lines.push(
      marker(selected, false, theme) +
        (selected ? theme.focus(label) : label) +
        truncate(values[row] ?? "", columns - GUTTER - 2),
    )
  })

  if (state.entry?.field === "skills") {
    lines.push(
      "",
      theme.dim(pad("Skills", GUTTER)) + theme.accent(`${state.entry.value}_`),
      " ".repeat(GUTTER) + theme.dim("comma separated; enter to apply, esc to cancel"),
    )
  }
  return lines
}

function targetList(state: ConfigUIState, room: number, columns: number, theme: Theme): string[] {
  const employee = currentEmployee(state)
  const rows = targetRows(state)
  const lines = [
    breadcrumb(theme, "Employees", employee?.name ?? state.employeeId ?? "employee", "Targets"),
    "",
    theme.dim(`  ${pad("Host / profile", 26)}${pad("Model", 38)}Status`),
  ]
  const window = windowOf(state.cursor.targets, rows.length, Math.max(2, room - 3))
  for (let index = window.start; index < window.end; index++) {
    const row = rows[index]
    if (row === undefined) continue
    const selected = index === state.cursor.targets
    const target = isTarget(row.target) ? row.target : undefined
    const model = target?.model ?? (row.configured ? "empty - choose a model or remove" : "not configured")
    const verdict = targetControl(row, state.seats.control)
    const title = `${row.hostLabel} / ${row.profileLabel}`
    lines.push(
      marker(selected, row.configured && target === undefined, theme) +
        (selected ? theme.focus(pad(truncate(title, 25), 26)) : pad(truncate(title, 25), 26)) +
        (row.configured ? theme.accent(pad(truncate(model, 37), 38)) : theme.dim(pad(truncate(model, 37), 38))) +
        (row.configured ? controlStyle(verdict.label, theme)(verdict.label) : theme.dim("-")),
    )
    if (selected && target !== undefined) {
      const summary = optionSummary(target)
      if (summary.length > 0) lines.push("  " + theme.dim(`options: ${summary}`))
    }
  }
  if (window.end < rows.length || window.start > 0) {
    lines.push(theme.dim(`  ${window.start + 1}-${window.end} of ${rows.length}`))
  }
  return lines
}

function optionEditor(state: ConfigUIState, columns: number, theme: Theme): string[] {
  const employee = currentEmployee(state)
  const row = currentTargetRow(state)
  const target = isTarget(row?.target) ? row.target : undefined
  const descriptors = targetDescriptors(state)
  const lines = [
    breadcrumb(
      theme,
      "Employees",
      employee?.name ?? state.employeeId ?? "employee",
      "Targets",
      `${row?.hostLabel ?? "Host"} options`,
    ),
    "",
    theme.dim(`  ${pad("Option", GUTTER)}Value`),
  ]
  descriptors.forEach((descriptor, index) => {
    const selected = index === state.cursor.options
    const value = targetOptionValue(target, descriptor)
    const rendered =
      descriptor.type === "boolean"
        ? value === true
          ? "on"
          : "off"
        : selectOptionScale(descriptor.choices?.map((choice) => choice.id) ?? [], value)
    const label = pad(descriptor.label, GUTTER)
    lines.push(
      marker(selected, false, theme) +
        (selected ? theme.focus(label) : label) +
        (selected ? theme.accent(rendered) : truncate(rendered, columns - GUTTER - 2)),
    )
  })
  if (descriptors.length === 0) lines.push(theme.dim("  This model exposes no configurable options."))
  return lines
}

function modelPicker(state: ConfigUIState, room: number, columns: number, theme: Theme): string[] {
  if (state.targetId !== undefined) return targetModelPicker(state, room, columns, theme)
  // The default-model flow draws the same table for the same reason the
  // employee picker does — one model list, one effort control, one filter —
  // and differs only in whose choice it is and what enter will do with it.
  const choosingDefault = state.view === "default"
  const employee = currentEmployee(state)
  const entries = pickerEntries(state)
  const cycle = effortCycle(state)
  const width = pickerWidths(columns)

  const title = choosingDefault
    ? theme.heading("Default model")
    : breadcrumb(theme, "Employees", employee?.name ?? state.employeeId ?? "employee", "Model")
  const lines = [
    title + (state.filter.length > 0 ? theme.dim("   filter: ") + theme.accent(state.filter) : ""),
    "",
  ]

  if (state.models.length === 0) {
    lines.push(theme.dim("  No models to list."))
  }

  lines.push(theme.dim(`  ${pad("Model", width.model)}${pad("Context", width.context)}Reasoning`))

  const window = windowOf(state.cursor.models, entries.length, Math.max(2, room - 4))
  let lastGroup = ""
  for (let index = window.start; index < window.end; index++) {
    const entry = entries[index]
    if (!entry) continue
    const selected = index === state.cursor.models
    if (entry.groupStart && entry.providerLabel !== undefined && entry.providerLabel !== lastGroup) {
      lines.push(`  ${theme.heading(entry.providerLabel)}`)
      lastGroup = entry.providerLabel
    }
    const label = pad(truncate(labelOf(entry), width.model - 1), width.model)
    lines.push(
      marker(selected, false, theme) +
        (selected ? theme.focus(label) : label) +
        theme.dim(pad(entry.kind === "inherit" ? "-" : formatContext(entry.model?.contextWindow), width.context)) +
        reasoningCell(entry, selected, cycle, state.draftVariant, theme),
    )
  }
  if (entries.length === 1 && state.filter.length > 0) {
    lines.push(theme.dim(`  Nothing matches "${state.filter}". Press / to change the filter, or m to type a model.`))
  }
  if (window.end < entries.length || window.start > 0) {
    lines.push(theme.dim(`  ${window.start + 1}-${window.end} of ${entries.length}`))
  }
  if (choosingDefault) {
    lines.push(theme.dim("  Enter arms this model; the next screen asks who receives it."))
  }

  if (state.entry?.field === "filter") {
    lines.push("", theme.dim(pad("Filter", GUTTER)) + theme.accent(`${state.entry.value}_`))
  }
  if (state.entry?.field === "model") {
    lines.push(
      "",
      theme.dim(pad("Model", GUTTER)) + theme.accent(`${state.entry.value}_`),
      " ".repeat(GUTTER) +
        theme.dim(
          choosingDefault
            ? "written provider/model, e.g. anthropic/claude-opus-4-5"
            : "written provider/model, e.g. anthropic/claude-opus-4-5; empty to inherit",
        ),
    )
  }
  return lines
}

/**
 * Which host/profile the default is for.
 *
 * The same table the per-employee flow opens, minus the employee: a default is
 * a target like any other, and picking the target first is what lets the model
 * list below come from that host's catalogue instead of from nowhere.
 */
function defaultTargetChooser(state: ConfigUIState, room: number, columns: number, theme: Theme): string[] {
  const rows = targetRows(state)
  const lines = [
    breadcrumb(theme, "Default model", "Which target"),
    "",
    theme.dim(`  ${pad("Host / profile", 26)}${pad("Models", 12)}Seat control`),
  ]
  const window = windowOf(state.cursor["default-target"], rows.length, Math.max(2, room - 3))
  for (let index = window.start; index < window.end; index++) {
    const row = rows[index]
    if (row === undefined) continue
    const selected = index === state.cursor["default-target"]
    const known = state.catalogues[row.id]?.models.length
    const models = known === undefined ? "load on open" : `${known} known`
    const verdict = targetControl(row, state.seats.control)
    const title = `${row.hostLabel} / ${row.profileLabel}`
    lines.push(
      marker(selected, false, theme) +
        (selected ? theme.focus(pad(truncate(title, 25), 26)) : pad(truncate(title, 25), 26)) +
        theme.dim(pad(models, 12)) +
        controlStyle(verdict.label, theme)(verdict.label),
    )
  }
  if (window.end < rows.length || window.start > 0) {
    lines.push(theme.dim(`  ${window.start + 1}-${window.end} of ${rows.length}`))
  }
  lines.push("", theme.dim("  The model you pick next is written into this target for every employee the scope names."))
  return lines
}

/**
 * Who receives the default model, and what each answer costs.
 *
 * The two scopes are named rows rather than a follow-up prompt so the choice
 * is the same shape as every other decision in this UI: visible, cursorable,
 * and expandable into the sentence that says exactly what it will overwrite.
 * The counts come from the working copy of `seats`, so they are true for the
 * config as edited, not as saved.
 */
function applyScopeChooser(state: ConfigUIState, columns: number, theme: Theme): string[] {
  const choice = state.defaultChoice
  const described = choice === undefined ? "" : describeDefaultChoice(state, choice)
  const unseated = defaultUnseatedIds(state).length
  const total = state.roster.length
  const targeted = choice?.targetId !== undefined
  const targetRow = currentTargetRow(state)
  const where = targeted
    ? `${targetRow?.hostLabel ?? choice?.host ?? "target"} / ${targetRow?.profileLabel ?? "default"}`
    : undefined

  const lines = [
    where === undefined
      ? breadcrumb(theme, "Default model", described, "Who gets it")
      : breadcrumb(theme, "Default model", where, described, "Who gets it"),
    "",
    theme.dim(`  ${pad("Scope", GUTTER)}Effect`),
  ]
  DEFAULT_APPLY_ROWS.forEach((row, index) => {
    const selected = index === state.cursor.apply
    const label = pad(row === "unseated" ? "Unseated only" : "All employees", GUTTER)
    const value =
      row === "unseated"
        ? theme.accent(`${unseated} of ${total} ${targeted ? "have no model here yet" : "have no seat yet"}`)
        : theme.warn(`overwrites all ${total}`)
    lines.push(marker(selected, false, theme) + (selected ? theme.focus(label) : label) + value)
    if (!selected) return
    const detail =
      row === "unseated"
        ? targeted
          ? `Only employees with no model for this target receive it. Anyone who already has one keeps it, and their other targets are untouched either way.`
          : `Only employees without a seat receive this model. Seated employees keep theirs.`
        : targeted
          ? `Every employee on the roster moves onto this model for this target, including ones you configured one by one. Their other targets are untouched.`
          : `Every employee on the roster moves onto this model, including ones you configured one by one.`
    for (const line of wrapAt(detail, Math.max(24, columns - GUTTER - 2), "").split("\n")) {
      lines.push(" ".repeat(GUTTER + 2) + theme.dim(line))
    }
  })
  lines.push("", theme.dim("  esc cancels: nothing has been changed yet."))
  return lines
}

function targetModelPicker(state: ConfigUIState, room: number, columns: number, theme: Theme): string[] {
  const employee = currentEmployee(state)
  const row = currentTargetRow(state)
  const choosingDefault = state.view === "default"
  const entries = pickerEntries(state)
  // The two rightmost columns belong to the scroll rail, so every cell is
  // measured against what is left rather than against the terminal. Sizing the
  // table first and hanging the rail off the edge afterwards is how a row ends
  // up one character too long on exactly the widths nobody tests.
  const inner = Math.max(40, columns - 2)
  const widths = targetPickerWidths(inner)
  const target = isTarget(row?.target) ? row.target : undefined
  const configuredModel = target?.model
  const where = `${row?.hostLabel ?? "target"} / ${row?.profileLabel ?? "default"}`
  const head = [
    theme.title(choosingDefault ? `Default model for ${where}` : `Select model for ${where}`),
    theme.dim(
      choosingDefault
        ? "Enter arms this model; the next screen asks who receives it."
        : `Choose the model to use when ${employee?.name ?? state.employeeId ?? "this employee"} launches matching subagents.`,
    ),
    "",
  ]
  // No "Model" above the first column. The rows under it are model names and
  // nothing else, so the word is a label for something already obvious, and
  // dropping it lets Context and Reasoning read as the two columns that are
  // actually controls.
  const body = [theme.dim(`  ${" ".repeat(widths.model)}${pad("Context", widths.context)}Reasoning`)]
  const window = windowOf(state.cursor.models, entries.length, Math.max(2, room - 7))
  let lastGroup = ""
  for (let index = window.start; index < window.end; index++) {
    const entry = entries[index]
    if (entry === undefined) continue
    if (entry.groupStart && entry.providerLabel !== undefined && entry.providerLabel !== lastGroup) {
      body.push("", `  ${theme.group(entry.providerLabel)}`)
      lastGroup = entry.providerLabel
    }
    const selected = index === state.cursor.models
    const configured = entry.kind === "model" && entry.model?.id === configuredModel
    // An explicit `false` only. `undefined` means the host was never asked, and
    // greying a row out on "we do not know" would disable the whole list on
    // every host that cannot answer and on the first open of the one that can.
    const barred = entry.kind === "model" && entry.model?.available === false
    const place: Row = { selected, configured, target }
    const modelLabel =
      entry.kind === "inherit"
        ? "Auto"
        : `${entry.model?.label ?? labelOf(entry)}${configured ? " \u2713" : ""}${barred ? " (unavailable)" : ""}`
    const label = pad(truncate(modelLabel, widths.model - 1), widths.model)
    const context = pad(truncate(targetContextCell(state, entry, place, barred), widths.context - 1), widths.context)
    // No reasoning control on a row that cannot be chosen: a stepper the user
    // can move but never apply is the false control this picker refuses.
    const reasoning = truncate(barred ? DASH : targetReasoningCell(state, entry, place), widths.reasoning)
    const content = label + context + reasoning
    body.push(
      pickerGutter(selected, barred, theme) +
        (selected
          ? theme.selection(fit(content, inner - 2))
          : barred
            ? theme.dim(fit(content, inner - 2))
            : (configured ? theme.good(label) : label) + theme.dim(context + reasoning)),
    )
  }
  if (entries.length === 1 && state.filter.length > 0) {
    body.push(theme.dim(`  Nothing matches "${state.filter}". Press enter to use it as this target's model id.`))
  }

  const typed = state.entry?.field === "filter" ? state.entry.value : state.filter
  const searchText = typed.length > 0 ? `${typed}_` : "Search models..."
  const lines = [
    ...head,
    ...rail(body, window.start, window.end - window.start, entries.length, inner, theme),
    "",
    theme.accent(CURSOR) + " " + theme.search(fit(searchText, inner - 2)),
  ]
  if (state.entry?.field === "model") {
    lines.push(
      "",
      theme.dim(pad("Model", GUTTER)) + theme.accent(`${state.entry.value}_`),
      " ".repeat(GUTTER) + theme.dim("type this host's model id; empty removes the target"),
    )
  }
  return lines
}

/**
 * The scroll rail down the right edge of the picker's list.
 *
 * It replaces the `1-8 of 20` line the picker used to print under the table.
 * That line answered "is there more" only after the user had read to the
 * bottom and looked for it; a thumb answers it in peripheral vision, and it
 * answers "how much more" as well, which the counter never did without
 * arithmetic.
 *
 * Both glyphs are box-drawing characters rather than colour: strip the theme
 * and the rail is still there, still the right length, still in the right
 * place. Colour only tells the thumb from the track faster.
 */
function rail(
  lines: string[],
  start: number,
  visible: number,
  total: number,
  columns: number,
  theme: Theme,
): string[] {
  const height = lines.length
  if (height === 0) return lines
  const span = Math.max(1, Math.min(total, visible))
  // Nothing to scroll: a full-height thumb reads as a control, and a control
  // that cannot move is a lie. Keep the gutter so the rows do not shift.
  if (total <= span) return lines.map((line) => `${fit(line, columns)}  `)
  const size = clamp(Math.round((span / Math.max(1, total)) * height), 1, height)
  const travel = height - size
  const offset = clamp(Math.round((start / (total - span)) * travel), 0, travel)
  return lines.map((line, index) => {
    const inThumb = index >= offset && index < offset + size
    return `${fit(line, columns)} ${inThumb ? theme.focus(THUMB) : theme.dim(TRACK)}`
  })
}

/**
 * The Context column.
 *
 * One value, the one in force, on every row including the highlighted one.
 * The column used to fan out into the whole scale under the cursor, which put
 * a second horizontal control next to the reasoning stepper and made the two
 * compete for the same glance. `tab` is in the hint bar and the status line
 * names the window it moved to, so the change is still announced — just not by
 * permanently widening the table.
 */
function targetContextCell(state: ConfigUIState, entry: PickerEntry, row: Row, barred = false): string {
  if (entry.kind === "inherit") return DASH
  // A barred row still states its context window, because that is a fact about
  // the model and stays true whether or not this account may run it. What it
  // must not show is the *tier*, which is a control.
  const descriptor = barred ? undefined : targetPickerDescriptor(state, "context", entry)
  if (descriptor === undefined) return dashed(formatContext(entry.model?.contextWindow))
  return dashed(choiceLabel(descriptor, cellValue(state, descriptor, row)))
}

function targetReasoningCell(state: ConfigUIState, entry: PickerEntry, row: Row): string {
  if (entry.kind === "inherit") return DASH
  const descriptor = targetPickerDescriptor(state, "reasoning", entry)
  if (descriptor === undefined) return DASH
  const label = choiceLabel(descriptor, cellValue(state, descriptor, row)) ?? "default"
  return row.selected ? `${LEFT} ${label} ${RIGHT}` : label
}

/** Where a picker row is: under the cursor, already saved, or neither. */
interface Row {
  selected: boolean
  configured: boolean
  target: SeatTarget | undefined
}

/**
 * The value one row should show for one option.
 *
 * Three sources, in the order that makes each row answer for itself: the draft
 * belongs to the highlighted row alone, the saved target belongs to the row
 * that is configured, and everything else has only what the catalogue says.
 */
function cellValue(state: ConfigUIState, descriptor: ModelOptionDescriptor, row: Row): string | undefined {
  if (row.selected) return targetPickerOptionValue(state, descriptor)
  if (row.configured) {
    const saved = targetOptionValue(row.target, descriptor)
    if (typeof saved === "string") return saved
  }
  return descriptorValue(descriptor)
}

function choiceLabel(descriptor: ModelOptionDescriptor, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return descriptor.choices?.find((choice) => choice.id === value)?.label ?? value
}

/** An em dash for "there is nothing here", never an empty cell. */
function dashed(value: string | undefined): string {
  return value === undefined || value.length === 0 || value === "-" ? DASH : value
}

/**
 * The Reasoning column.
 *
 * The highlighted row shows the model's whole scale with the armed effort in
 * brackets, because that is the only row `left`/`right` acts on and the user
 * needs to see the range they are moving through. Other rows compress to
 * `low-max`, which still answers "does this model reason at all".
 *
 * The three states of `ModelVariants` get three different cells, and never a
 * blank one. "takes no effort" is a finding — the model genuinely accepts no
 * variant, so there is no control to draw and saying so is more use than an
 * empty column. "unknown" is an admission, and the note under the table backs
 * it with the full sentence about the host having the final say. Rendering
 * both as `-` would tell the user we had checked when we had not.
 *
 * The brackets stay in the text when colour is on. Colour marks the armed
 * level; the brackets are what survive a screen reader.
 */
function reasoningCell(
  entry: PickerEntry,
  selected: boolean,
  cycle: { values: Array<string | undefined>; known: boolean },
  draft: string | undefined,
  theme: Theme,
): string {
  if (entry.kind === "inherit") return selected ? theme.dim("no model, so no effort") : theme.dim("-")
  const variants = entry.model?.variants ?? { kind: "unknown" }
  if (!selected) {
    switch (variants.kind) {
      case "unknown":
        return theme.dim("unknown")
      case "none":
        return theme.dim("takes no effort")
      case "efforts":
        return theme.dim(
          variants.values.length === 1
            ? variants.values[0]!
            : `${variants.values[0]}-${variants.values[variants.values.length - 1]}`,
        )
    }
  }
  if (variants.kind === "none") return theme.dim("this model takes no reasoning effort")
  if (cycle.values.length <= 1) return theme.dim("this model takes no reasoning effort")
  return cycle.values
    .map((value) => {
      const text = value ?? "off"
      return value === draft ? theme.accent(`[${text}]`) : theme.dim(text)
    })
    .join(" ")
}

/**
 * Findings for what the user is looking at, rendered verbatim.
 *
 * The sentences come straight out of `diagnoseSeats` and are not reworded
 * here. One component decides what is wrong with a seats config and it is not
 * this one — otherwise the installer, the daemon and this UI drift into three
 * different opinions about the same file. Colour follows the severity the
 * diagnosis already declared rather than a judgement made at the last minute.
 */
function notes(state: ConfigUIState, issues: SeatIssue[], columns: number, theme: Theme): string[] {
  const scope = state.employeeId
  const shown =
    scope === undefined || state.view === "employees" || state.view === "menu"
      ? issues
      : issues.filter((issue) => issue.employeeId === undefined || issue.employeeId === scope)
  if (state.status.length === 0 && shown.length === 0) return []

  const lines = [""]
  if (state.status.length > 0) {
    lines.push(...wrapAt(state.status, columns, "  ").split("\n").map(theme.accent))
  }
  for (const issue of shown.slice(0, 4)) {
    const paint = issue.severity === "error" ? theme.alert : theme.warn
    const target = issue.targetId === undefined ? "" : `${issue.targetId}: `
    lines.push(...wrapAt(`${issue.severity}: ${target}${issue.message}`, columns, "  ").split("\n").map(paint))
  }
  if (shown.length > 4) lines.push(theme.dim(`  ...and ${shown.length - 4} more; see observer doctor.`))
  return lines
}

/** `key label` pairs for the current mode, keys picked out of the sentence. */
function hints(state: ConfigUIState, columns: number, theme: Theme): string[] {
  const bar = (...pairs: Array<[string, string]>): string[] => [
    pairs.map(([key, label]) => `${theme.accent(key)} ${theme.dim(label)}`).join("   "),
  ]
  /**
   * The model picker's bar, dot-separated and wrapped rather than clipped.
   *
   * This is the one hint bar long enough to outrun a narrow terminal, and it
   * is also the one carrying `esc to cancel`. Truncating it would take the way
   * out first, which is exactly backwards; wrapping costs a row of body and
   * keeps every key on screen.
   */
  const dotted = (...pairs: Array<[string, string]>): string[] => {
    const cells = pairs.map(([key, label]) => ({ text: `${theme.accent(key)} ${theme.dim(label)}`, width: key.length + 1 + label.length }))
    const rows: string[] = []
    let line = ""
    let used = 0
    for (const cell of cells) {
      if (line.length === 0) {
        line = cell.text
        used = cell.width
        continue
      }
      if (used + DOT.length + cell.width > columns) {
        rows.push(line)
        line = cell.text
        used = cell.width
        continue
      }
      line += theme.dim(DOT) + cell.text
      used += DOT.length + cell.width
    }
    if (line.length > 0) rows.push(line)
    return rows
  }

  if (state.confirmQuit) {
    return [
      theme.warn("Unsaved changes.") +
        "  " +
        bar(["s", "save and quit"], ["q", "quit anyway"], ["esc", "keep editing"])[0]!,
    ]
  }
  if (state.entry !== undefined) return bar(["enter", "apply"], ["esc", "cancel"])
  switch (state.view) {
    case "menu":
      return bar(["up/down", "move"], ["enter", "select"], ["c", "toggle seat control"], ["s", "save"], ["esc", "quit"])
    case "employees":
      return bar(
        ["up/down", "move"],
        ["enter", "configure"],
        ["c", "toggle seat control"],
        ["s", "save"],
        ["esc", "back"],
      )
    case "employee":
      return bar(["up/down", "move"], ["enter", "change"], ["s", "save"], ["esc", "back"])
    case "targets":
      return bar(["up/down", "move"], ["enter", "configure"], ["d", "remove"], ["s", "save"], ["esc", "back"])
    case "models":
      return state.targetId === undefined
        ? bar(
            ["up/down", "move"],
            ["left/right", "effort"],
            ["tab", "vendor"],
            ["/", "filter"],
            ["m", "type a model"],
            ["enter", "select"],
            ["esc", "back"],
          )
        : dotted(
            ["\u2191/\u2193", "to navigate"],
            ["\u2190/\u2192", "reasoning effort"],
            ["tab", "context window"],
            ["shift+tab", groupHint(state)],
            ["enter", "to select"],
            ["esc", "to cancel"],
          )
    case "options":
      return bar(["up/down", "move"], ["left/right", "change select"], ["enter", "toggle/change"], ["esc", "back"])
    case "default-target":
      return bar(["up/down", "move"], ["enter", "choose models for it"], ["esc", "back"])
    case "default":
      return state.targetId === undefined
        ? bar(
            ["up/down", "move"],
            ["left/right", "effort"],
            ["tab", "vendor"],
            ["/", "filter"],
            ["m", "type a model"],
            ["enter", "choose who gets it"],
            ["esc", "back"],
          )
        : dotted(
            ["\u2191/\u2193", "to navigate"],
            ["\u2190/\u2192", "reasoning effort"],
            ["tab", "context window"],
            ["shift+tab", groupHint(state)],
            ["enter", "to choose who gets it"],
            ["esc", "to cancel"],
          )
    case "apply":
      return bar(["up/down", "move"], ["enter", "apply"], ["esc", "cancel"])
  }
}

/**
 * Plain-text seat report for a pipe, a CI log or `observer config | less`.
 *
 * Raw mode on a non-TTY either throws or hangs forever, so the interactive
 * path is never entered there. Reporting instead of refusing follows
 * `observer doctor`: the command still answers the question you asked, it just
 * cannot take your keystrokes. No theme reaches this function — a pipe gets
 * text, whatever the terminal it was launched from could have drawn.
 */
export function renderReport(seats: SeatsConfig, roster: EmployeeRow[], profiles: TargetProfile[] = []): string[] {
  const diagnosis = diagnoseSeats(seats)
  const issues = seatIssues(seats)
  const lines = [
    "Observer seats",
    "",
    `${pad("control", GUTTER)}${seats.control ? "on" : "off"}`,
    `${pad("in effect", GUTTER)}${diagnosis.effective ? "yes" : "no"}`,
    "",
  ]

  const configured = roster.filter((row) => seats.employees[row.id] !== undefined)
  if (configured.length === 0) {
    lines.push("No employee has a seat. Every subagent inherits the session's model.")
  } else if (profiles.length > 0) {
    for (const row of configured) {
      lines.push(...reportTargetSeat(row.id, seats.employees[row.id]!, profiles, seats.control))
    }
  } else {
    for (const row of configured) {
      const seat = seats.employees[row.id]!
      const configured = opencodeSeat(seat)
      const model = configured?.model ?? "inherit"
      const variant = configured?.variant ?? "-"
      const skills = Array.isArray(seat.skills) ? seat.skills.map((skill) => skill.name).join(", ") : "-"
      lines.push(`${pad(row.id, 18)}${pad(model, 34)}${pad(variant, 8)}${skills.length > 0 ? skills : "-"}`)
    }
  }

  // Seats naming an id that is not on the roster are the reason this loop is
  // separate: they are invisible in a roster-ordered table, and they are
  // exactly the typo a user needs told about.
  const strays = Object.keys(seats.employees).filter((id) => !roster.some((row) => row.id === id))
  for (const id of strays) {
    if (profiles.length > 0) lines.push(...reportTargetSeat(`${id} (not on the roster)`, seats.employees[id]!, profiles, seats.control))
    else lines.push(`${pad(id, 18)}not on the roster`)
  }

  if (issues.length > 0) {
    lines.push("", "Notes")
    for (const issue of issues) {
      const scope = [issue.employeeId, issue.targetId].filter((part): part is string => typeof part === "string").join(" / ")
      lines.push(`  ${issue.severity}: ${scope.length > 0 ? `${scope}: ` : ""}${issue.message}`)
    }
  }
  lines.push("", "Run `observer config` in a terminal to change any of this.")
  return lines
}

function reportTargetSeat(
  employee: string,
  seat: SeatSpec,
  profiles: TargetProfile[],
  control: boolean,
): string[] {
  const targets = seatTargets(seat)
  const ids = Object.keys(targets).sort()
  if (ids.length === 0) {
    const skills = Array.isArray(seat.skills) ? seat.skills.map((skill) => skill.name).join(", ") : ""
    return [`${employee}  no targets${skills.length > 0 ? `  skills: ${skills}` : ""}`]
  }
  const lines = [employee]
  for (const id of ids) {
    const target = targets[id]
    const host = isTarget(target) ? target.host : targetHostFromId(id)
    const profile = profiles.find((entry) => entry.id === id)
    const profileMatches = profile?.host === host
    const row: TargetRow = {
      id,
      host,
      hostLabel: profileMatches ? profile.hostLabel : host,
      profileLabel: profile?.profileLabel ?? profileLabelFromId(id),
      ...(profileMatches ? { capabilities: profile.capabilities } : {}),
      configured: true,
      target,
    }
    const verdict = targetControl(row, control)
    const model = isTarget(target) && typeof target.model === "string" ? target.model : "inherit"
    const options = isTarget(target) ? optionSummary(target) : "not a target"
    lines.push(`  ${pad(id, 22)}${pad(model, 38)}${pad(verdict.label, 26)}${options || "-"}`)
  }
  return lines
}

/**
 * What `shift+tab` will move away from, named.
 *
 * "group" alone is a verb with no object: it says a key exists without saying
 * what pressing it does to this screen. Naming the section the cursor is in
 * turns the hint into a readout as well as an instruction, which is the same
 * job the value column does on the main menu.
 */
function groupHint(state: ConfigUIState): string {
  const label = pickerEntries(state)[state.cursor.models]?.providerLabel
  const word = label?.split(" ")[0]?.toLowerCase()
  return word === undefined ? "group" : `group: ${word}`
}

/** `Employees > Arjun Mehta > Model`, with the leaf picked out. */
function breadcrumb(theme: Theme, ...parts: string[]): string {
  const trail = parts.slice(0, -1)
  const leaf = parts[parts.length - 1] ?? ""
  if (trail.length === 0) return theme.heading(leaf)
  return theme.dim(`${trail.join(" > ")} > `) + theme.heading(leaf)
}

interface ListWidths {
  name: number
  role: number
  model: number
  effort: number
  skills: number
}

/**
 * Column widths for the terminal we actually got.
 *
 * Name and effort are fixed because their content is bounded; role, model and
 * skills share what is left, so an 80-column window keeps all five columns
 * readable instead of pushing skills off the edge.
 */
function listWidths(columns: number): ListWidths {
  const name = 20
  const effort = 9
  const remaining = columns - 2 - name - effort
  const role = clamp(Math.round(remaining * 0.42), 14, 34)
  const model = clamp(Math.round(remaining * 0.4), 16, 36)
  return { name, role, model, effort, skills: Math.max(0, remaining - role - model) }
}

/**
 * Picker column widths.
 *
 * The Reasoning column is sized first, because the widest thing it ever holds
 * is a known quantity — the full suggestion scale with one level bracketed,
 * `off none minimal low medium [high] xhigh max` — and a scale that truncates
 * mid-word is a control the user cannot read. Model names take what is left;
 * they truncate gracefully because the provider is already a group header.
 */
function pickerWidths(columns: number): { model: number; context: number } {
  const context = 9
  const reasoning = 46
  return { model: clamp(columns - 2 - context - reasoning, 20, 40), context }
}

function targetPickerWidths(columns: number): { model: number; context: number; reasoning: number } {
  const context = clamp(Math.round(columns * 0.18), 12, 24)
  const reasoning = 18
  return { model: Math.max(24, columns - 2 - context - reasoning), context, reasoning }
}

/**
 * `>` for the cursor, `!` for a seat `diagnoseSeats` has something to say
 * about. Colour repeats what the character already says; it never replaces it.
 */
function marker(selected: boolean, flagged: boolean, theme: Theme): string {
  return `${selected ? theme.accent(">") : " "}${flagged ? theme.alert("!") : " "}`
}

/** The picker's own two-column gutter: `> ` is for lists that also flag rows. */
function cursor(selected: boolean, theme: Theme): string {
  return selected ? `${theme.accent(CURSOR)} ` : "  "
}

/**
 * The model picker's gutter, which also has to say "you cannot pick this".
 *
 * `x` in the second column, on the same principle as `marker`'s `!`: the
 * character carries the meaning and the colour only repeats it. That matters
 * twice over here. Strip the theme — a pipe, a dumb terminal, `NO_COLOR` — and
 * a dimmed row is indistinguishable from an enabled one, so dimming alone would
 * make the whole feature vanish for the users most likely to be scripting
 * against it. And the gutter is the one part of a row `truncate` can never
 * eat, so the `(unavailable)` suffix beside the model name can be clipped on a
 * narrow terminal without the row losing its meaning.
 */
function pickerGutter(selected: boolean, barred: boolean, theme: Theme): string {
  const head = selected ? theme.accent(CURSOR) : " "
  return barred ? `${head}${theme.dim("x")}` : `${head} `
}

/**
 * Exactly `width` visible characters, padded or clipped.
 *
 * `padEnd` deliberately adds a separating space when a cell has outgrown its
 * column, which is right for a table and wrong for a full-bleed row: a
 * highlighted band or a scroll rail has to land on a known column, and one
 * stray space pushes it off the edge on precisely the widths where the content
 * only just fits.
 */
function fit(text: string, width: number): string {
  if (width <= 0) return ""
  const clipped = truncate(text, width)
  const gap = width - visibleLength(clipped)
  return gap > 0 ? clipped + " ".repeat(gap) : clipped
}

/**
 * A window over a list that keeps the cursor visible.
 *
 * Clamped at both ends rather than centred, so the top of the roster does not
 * float in blank space and the bottom does not scroll past its last row.
 */
function windowOf(cursor: number, length: number, room: number): { start: number; end: number } {
  const size = Math.max(1, Math.min(length, room))
  if (length <= size) return { start: 0, end: length }
  const start = clamp(cursor - Math.floor(size / 2), 0, length - size)
  return { start, end: start + size }
}

function wrapAt(text: string, columns: number, indent: string): string {
  const width = Math.max(20, columns - indent.length)
  const words = text.split(" ")
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (line.length === 0) line = word
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`
    else {
      lines.push(indent + line)
      line = word
    }
  }
  if (line.length > 0) lines.push(indent + line)
  return lines.join("\n")
}

function labelOf(entry: PickerEntry): string {
  if (entry.kind === "inherit") return "inherit (use the session's model)"
  const id = entry.model?.id ?? ""
  const slash = id.indexOf("/")
  return slash >= 0 ? id.slice(slash + 1) : id
}

function opencodeSeat(seat: SeatSpec | undefined): { model: string; variant?: string } | undefined {
  return readOpencodeTarget(seatTargets(seat)[LEGACY_TARGET_ID])
}

function isTarget(value: unknown): value is SeatTarget {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function optionSummary(target: SeatTarget): string {
  if (!Array.isArray(target.options)) return ""
  return target.options
    .filter((option) => option && typeof option === "object" && typeof option.id === "string")
    .map((option) => `${option.id}=${String(option.value)}`)
    .join(", ")
}

function selectOptionScale(choices: string[], current: string | boolean | undefined): string {
  return ["off", ...choices]
    .map((choice) => (choice === (current ?? "off") ? `[${choice}]` : choice))
    .join(" ")
}

function controlStyle(label: TargetControl["label"], theme: Theme): (text: string) => string {
  if (label === "applied") return theme.good
  if (label === "experimental") return theme.warn
  return theme.dim
}

function targetHostFromId(targetId: string): string {
  const separator = targetId.indexOf(":")
  return separator === -1 ? targetId : targetId.slice(0, separator)
}

function profileLabelFromId(targetId: string): string {
  const separator = targetId.indexOf(":")
  return separator === -1 ? "default" : targetId.slice(separator + 1)
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

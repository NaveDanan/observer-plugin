import {
  LEGACY_TARGET_ID,
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
  type EmployeeRow,
  type MenuRowKind,
  type PickerEntry,
  type TargetProfile,
  type TargetControl,
  type TargetRow,
  currentEmployee,
  currentTargetRow,
  employeeRows,
  effortCycle,
  menuRows,
  pickerEntries,
  seatOf,
  targetControl,
  targetDescriptors,
  targetOptionValue,
  targetRows,
} from "./config-ui-state.js"
import { PLAIN_THEME, type Theme, padEnd as pad, truncate } from "./theme.js"

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
  const lines = [...header(state, diagnosis.effective, columns, theme)]

  const footer = [...notes(state, issues, columns, theme), "", ...hints(state, theme)]
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
      lines.push(...modelPicker(state, room, columns, theme))
      break
    case "options":
      lines.push(...optionEditor(state, columns, theme))
      break
  }

  lines.push(...footer)
  return lines.map((line) => truncate(line, columns))
}

/**
 * What is in force, on every screen.
 *
 * A config UI that lets you pick a model without saying that the flag which
 * would apply it is off is a UI that lies, so these two answers are fixed
 * chrome rather than something you have to go and look for. The narrowings —
 * which host, which delegations — live on the menu row that owns the flag,
 * where there is room to say them in full.
 */
function header(state: ConfigUIState, effective: boolean, columns: number, theme: Theme): string[] {
  const control = state.seats.control
  const lines = [
    theme.heading("Observer config") + theme.dim(" - host targets, model options and skills per employee"),
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
    save: "Save & exit",
    exit: "Exit",
  }
  const values: Record<MenuRowKind, string> = {
    control: state.seats.control ? theme.good("on") : theme.warn("off"),
    employees: `${state.roster.length} people, ${seated === 0 ? "none seated" : `${seated} seated`}${
      errors > 0 ? theme.alert(`, ${errors} to fix`) : ""
    }`,
    save: theme.warn("write these seats to config.json"),
    exit: theme.dim("leave observer config"),
  }
  const details: Record<MenuRowKind, string[]> = {
    control:
      state.profiles.length === 0
        ? [
            "OpenCode only - Codex, Claude Code and Copilot CLI are not seated",
            "`general` delegations only - any other agent keeps its own prompt, tools and model",
          ]
        : [
            "OpenCode targets are applied; Codex is experimental; Claude Code and Copilot CLI targets are recorded only",
            "Each target says whether it is applied, experimental, configured, or not applied to children",
            "`general` OpenCode delegations only - any other agent keeps its own prompt, tools and model",
          ],
    employees: ["Give a person one target per host/profile, plus shared skills."],
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
  const employee = currentEmployee(state)
  const entries = pickerEntries(state)
  const cycle = effortCycle(state)
  const width = pickerWidths(columns)

  const lines = [
    breadcrumb(theme, "Employees", employee?.name ?? state.employeeId ?? "employee", "Model") +
      (state.filter.length > 0 ? theme.dim("   filter: ") + theme.accent(state.filter) : ""),
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

  if (state.entry?.field === "filter") {
    lines.push("", theme.dim(pad("Filter", GUTTER)) + theme.accent(`${state.entry.value}_`))
  }
  if (state.entry?.field === "model") {
    lines.push(
      "",
      theme.dim(pad("Model", GUTTER)) + theme.accent(`${state.entry.value}_`),
      " ".repeat(GUTTER) + theme.dim("written provider/model, e.g. anthropic/claude-opus-4-5; empty to inherit"),
    )
  }
  return lines
}

function targetModelPicker(state: ConfigUIState, room: number, columns: number, theme: Theme): string[] {
  const employee = currentEmployee(state)
  const row = currentTargetRow(state)
  const entries = pickerEntries(state)
  const modelWidth = Math.max(28, columns - 14)
  const lines = [
    breadcrumb(
      theme,
      "Employees",
      employee?.name ?? state.employeeId ?? "employee",
      "Targets",
      `${row?.hostLabel ?? "Host"} model`,
    ) + (state.filter.length > 0 ? theme.dim("   filter: ") + theme.accent(state.filter) : ""),
    "",
    theme.dim(`  ${pad("Model", modelWidth)}Context`),
  ]
  const window = windowOf(state.cursor.models, entries.length, Math.max(2, room - 3))
  for (let index = window.start; index < window.end; index++) {
    const entry = entries[index]
    if (entry === undefined) continue
    const selected = index === state.cursor.models
    const label = pad(truncate(labelOf(entry), modelWidth - 1), modelWidth)
    lines.push(
      marker(selected, false, theme) +
        (selected ? theme.focus(label) : label) +
        theme.dim(entry.kind === "inherit" ? "-" : formatContext(entry.model?.contextWindow)),
    )
  }
  if (entries.length === 1 && state.filter.length > 0) {
    lines.push(theme.dim(`  Nothing matches "${state.filter}". Press / to change the filter, or m to type a model.`))
  }
  if (state.entry?.field === "filter") {
    lines.push("", theme.dim(pad("Filter", GUTTER)) + theme.accent(`${state.entry.value}_`))
  }
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
function hints(state: ConfigUIState, theme: Theme): string[] {
  const bar = (...pairs: Array<[string, string]>): string[] => [
    pairs.map(([key, label]) => `${theme.accent(key)} ${theme.dim(label)}`).join("   "),
  ]

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
        : bar(
            ["up/down", "move"],
            ["/", "filter"],
            ["m", "type a model"],
            ["enter", "select"],
            ["esc", "back"],
          )
    case "options":
      return bar(["up/down", "move"], ["left/right", "change select"], ["enter", "toggle/change"], ["esc", "back"])
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

/**
 * `>` for the cursor, `!` for a seat `diagnoseSeats` has something to say
 * about. Colour repeats what the character already says; it never replaces it.
 */
function marker(selected: boolean, flagged: boolean, theme: Theme): string {
  return `${selected ? theme.accent(">") : " "}${flagged ? theme.alert("!") : " "}`
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

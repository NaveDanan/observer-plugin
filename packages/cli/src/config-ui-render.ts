import { type SeatIssue, type SeatsConfig, diagnoseSeats } from "@observer-ai/daemon"
import { formatContext } from "./models.js"
import { diagnoseOpencodeSeats } from "./seat-agents.js"
import {
  type ConfigUIState,
  EMPLOYEE_ROWS,
  type EmployeeRow,
  type MenuRowKind,
  type PickerEntry,
  currentEmployee,
  effortCycle,
  menuRows,
  pickerEntries,
  seatOf,
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
    case "models":
      lines.push(...modelPicker(state, room, columns, theme))
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
    theme.heading("Observer config") + theme.dim(" - model, reasoning effort and skills per employee"),
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
    control: [
      "OpenCode only - Codex, Claude Code and Copilot CLI are not seated",
      "`general` delegations only - any other agent keeps its own prompt, tools and model",
    ],
    employees: ["Give a person a model, a reasoning effort and skills."],
    save: ["Writes seats to config.json, regenerates the agent definitions, and leaves."],
    exit: [],
  }

  const lines = [theme.heading("Main menu"), ""]
  rows.forEach((row, index) => {
    const selected = index === at
    const label = pad(labels[row], GUTTER)
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
    const model = typeof seat?.model === "string" ? seat.model : "inherit"
    const variant = typeof seat?.variant === "string" ? seat.variant : "-"
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
        (typeof seat?.model === "string" ? theme.accent(modelCell) : theme.dim(modelCell)) +
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
  const model = typeof seat?.model === "string" ? seat.model : "inherit (the session's model)"
  const variant = typeof seat?.variant === "string" ? seat.variant : "-"
  const skills = Array.isArray(seat?.skills) ? seat.skills.map((skill) => skill.name).join(", ") : ""

  const values: Record<(typeof EMPLOYEE_ROWS)[number], string> = {
    model: `${typeof seat?.model === "string" ? theme.accent(model) : theme.dim(model)}   ${theme.dim("effort")} ${variant}`,
    skills: skills.length > 0 ? skills : theme.dim("none"),
    reset: theme.dim("clear this employee's model, effort and skills"),
  }
  const labels: Record<(typeof EMPLOYEE_ROWS)[number], string> = {
    model: "Model",
    skills: "Skills",
    reset: "Reset to defaults",
  }

  const lines = [
    breadcrumb(theme, "Employees", employee?.name ?? state.employeeId ?? "employee"),
    theme.dim(`  ${employee?.role ?? ""}`),
    "",
  ]
  EMPLOYEE_ROWS.forEach((row, index) => {
    const selected = index === state.cursor.employee
    const label = pad(labels[row], GUTTER)
    lines.push(
      marker(selected, false, theme) +
        (selected ? theme.focus(label) : label) +
        truncate(values[row], columns - GUTTER - 2),
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

function modelPicker(state: ConfigUIState, room: number, columns: number, theme: Theme): string[] {
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
    lines.push(...wrapAt(`${issue.severity}: ${issue.message}`, columns, "  ").split("\n").map(paint))
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
    case "models":
      return bar(
        ["up/down", "move"],
        ["left/right", "effort"],
        ["tab", "vendor"],
        ["/", "filter"],
        ["m", "type a model"],
        ["enter", "select"],
        ["esc", "back"],
      )
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
export function renderReport(seats: SeatsConfig, roster: EmployeeRow[]): string[] {
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
  } else {
    for (const row of configured) {
      const seat = seats.employees[row.id]!
      const model = typeof seat.model === "string" ? seat.model : "inherit"
      const variant = typeof seat.variant === "string" ? seat.variant : "-"
      const skills = Array.isArray(seat.skills) ? seat.skills.map((skill) => skill.name).join(", ") : "-"
      lines.push(`${pad(row.id, 18)}${pad(model, 34)}${pad(variant, 8)}${skills.length > 0 ? skills : "-"}`)
    }
  }

  // Seats naming an id that is not on the roster are the reason this loop is
  // separate: they are invisible in a roster-ordered table, and they are
  // exactly the typo a user needs told about.
  const strays = Object.keys(seats.employees).filter((id) => !roster.some((row) => row.id === id))
  for (const id of strays) lines.push(`${pad(id, 18)}not on the roster`)

  if (issues.length > 0) {
    lines.push("", "Notes")
    for (const issue of issues) lines.push(`  ${issue.severity}: ${issue.message}`)
  }
  lines.push("", "Run `observer config` in a terminal to change any of this.")
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

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

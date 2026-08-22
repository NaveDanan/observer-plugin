import { type SeatIssue, type SeatsConfig, diagnoseSeats } from "@observer-ai/daemon"
import { formatContext } from "./models.js"
import {
  type ConfigUIState,
  EMPLOYEE_ROWS,
  type EmployeeRow,
  type PickerEntry,
  currentEmployee,
  effortCycle,
  pickerEntries,
  seatOf,
} from "./config-ui-state.js"

/**
 * Turns state into lines of text. Pure, and emits no ANSI at all.
 *
 * Zero escape codes is a deliberate continuation of the rest of this CLI,
 * which says `installed` / `not installed` in words and aligns with `pad()`
 * rather than colouring anything. Three things fall out of it: `NO_COLOR` is
 * honoured by construction rather than by a branch, the output is identical in
 * a terminal and in a test assertion, and every distinction the UI draws — the
 * cursor, a warning, a selected effort — survives being read aloud or piped
 * through `col`. A screen reader gets the same information a sighted user does.
 *
 * The cost is that the cursor is a `>` in a gutter instead of a reverse-video
 * bar. In a fixed-width table that reads fine, and it is the honest trade.
 */

export interface Viewport {
  rows: number
  columns: number
}

export const DEFAULT_VIEWPORT: Viewport = { rows: 24, columns: 100 }

/** Width of the label gutter, matching `observer status` and `observer doctor`. */
const GUTTER = 20

export function render(state: ConfigUIState, viewport: Viewport = DEFAULT_VIEWPORT): string[] {
  const columns = Math.max(60, viewport.columns)
  const diagnosis = diagnoseSeats(state.seats)
  const lines = [...header(state, diagnosis.effective, columns)]

  const footer = [...notes(state, diagnosis.issues, columns), "", ...hints(state)]
  // The list is whatever is left after the fixed chrome, so a short terminal
  // loses rows from the middle of the list rather than losing the key hints
  // that say how to get out of it.
  const room = Math.max(3, viewport.rows - lines.length - footer.length - 1)

  switch (state.view) {
    case "employees":
      lines.push(...employeeList(state, diagnosis.issues, room, columns))
      break
    case "employee":
      lines.push(...employeeDetail(state, columns))
      break
    case "models":
      lines.push(...modelPicker(state, room, columns))
      break
  }

  lines.push(...footer)
  return lines.map((line) => truncate(line, columns))
}

function header(state: ConfigUIState, effective: boolean, columns: number): string[] {
  const control = state.seats.control
  const lines = [
    truncate(`Observer config - model, reasoning effort and skills per employee`, columns),
    "",
    // The plainest possible statement of whether any of this is doing
    // anything, on every screen. A config UI that lets you pick a model
    // without saying the flag that would apply it is off is a UI that lies.
    ...field(
      "Seat control",
      control ? "on - Observer sets the model and effort" : "off - model and effort are inert; skills still apply",
      columns,
    ),
    ...field("Right now", effective ? "this config changes what runs" : "this config changes nothing", columns),
    // Two independent narrowings of "what does any of this touch", under one
    // label because that is the one question they both answer. The second is
    // `observer doctor`'s sentence word for word: seat control rewrites
    // `subagent_type`, and doing that to a specialised agent would throw away
    // its own prompt, tools and deny-by-default permissions, so only `general`
    // delegations are ever reseated. A header that named the host but not the
    // agent type would still be letting a user believe every subagent moves.
    ...field("Applies to", "OpenCode only - Codex, Claude Code and Copilot CLI are not seated", columns),
    ...field("", "`general` delegations only - any other agent keeps its own prompt, tools and model", columns),
    state.dirty ? `${pad("Unsaved changes", GUTTER)}press s to write them to config.json` : "",
    "",
  ]
  return lines
}

/**
 * One `label   value` row, wrapped into the gutter instead of clipped.
 *
 * The alternative is `truncate`, and truncating this particular column loses
 * the end of sentences that exist to be read in full — "...keeps its own
 * prompt, tools and mo..." is worse than two lines.
 */
function field(label: string, value: string, columns: number): string[] {
  const wrapped = wrapAt(value, Math.max(24, columns - GUTTER), "").split("\n")
  return wrapped.map((line, index) => (index === 0 ? pad(label, GUTTER) + line : " ".repeat(GUTTER) + line))
}

function employeeList(state: ConfigUIState, issues: SeatIssue[], room: number, columns: number): string[] {
  const width = listWidths(columns)
  const flagged = new Set(issues.filter((issue) => issue.employeeId !== undefined).map((issue) => issue.employeeId!))

  const lines = [
    `  ${pad("Employee", width.name)}${pad("Role", width.role)}${pad("Model", width.model)}${pad("Effort", width.effort)}${width.skills > 0 ? "Skills" : ""}`,
  ]

  const window = windowOf(state.cursor.employees, state.roster.length, room - 1)
  for (let index = window.start; index < window.end; index++) {
    const row = state.roster[index]
    if (!row) continue
    const seat = state.seats.employees[row.id]
    const model = typeof seat?.model === "string" ? seat.model : "inherit"
    const variant = typeof seat?.variant === "string" ? seat.variant : "-"
    const skills = Array.isArray(seat?.skills) ? seat.skills.map((skill) => skill.name).join(", ") : ""
    lines.push(
      marker(index === state.cursor.employees, flagged.has(row.id)) +
        pad(truncate(row.name, width.name - 1), width.name) +
        pad(truncate(row.role, width.role - 1), width.role) +
        pad(truncate(model, width.model - 1), width.model) +
        pad(variant, width.effort) +
        (width.skills > 0 ? truncate(skills.length > 0 ? skills : "-", width.skills) : ""),
    )
  }
  if (window.end < state.roster.length || window.start > 0) {
    lines.push(`  ${window.start + 1}-${window.end} of ${state.roster.length}`)
  }
  return lines
}

function employeeDetail(state: ConfigUIState, columns: number): string[] {
  const employee = currentEmployee(state)
  const seat = seatOf(state, state.employeeId)
  const model = typeof seat?.model === "string" ? seat.model : "inherit (the session's model)"
  const variant = typeof seat?.variant === "string" ? seat.variant : "-"
  const skills = Array.isArray(seat?.skills) ? seat.skills.map((skill) => skill.name).join(", ") : ""

  const values: Record<(typeof EMPLOYEE_ROWS)[number], string> = {
    model: `${model}   effort ${variant}`,
    skills: skills.length > 0 ? skills : "none",
    reset: "clear this employee's model, effort and skills",
  }
  const labels: Record<(typeof EMPLOYEE_ROWS)[number], string> = {
    model: "Model",
    skills: "Skills",
    reset: "Reset to defaults",
  }

  const lines = [`Configure ${employee?.name ?? state.employeeId ?? "employee"}`, `  ${employee?.role ?? ""}`, ""]
  EMPLOYEE_ROWS.forEach((row, index) => {
    lines.push(
      marker(index === state.cursor.employee, false) +
        pad(labels[row], GUTTER) +
        truncate(values[row], columns - GUTTER - 2),
    )
  })

  if (state.entry?.field === "skills") {
    lines.push(
      "",
      `${pad("Skills", GUTTER)}${state.entry.value}_`,
      `${pad("", GUTTER)}comma separated; enter to apply, esc to cancel`,
    )
  }
  return lines
}

function modelPicker(state: ConfigUIState, room: number, columns: number): string[] {
  const employee = currentEmployee(state)
  const entries = pickerEntries(state)
  const cycle = effortCycle(state)
  const width = pickerWidths(columns)

  const lines = [
    `Model for ${employee?.name ?? state.employeeId ?? "employee"}${state.filter.length > 0 ? `   filter: ${state.filter}` : ""}`,
    "",
  ]

  if (state.models.length === 0) {
    lines.push("  No models to list.")
  }

  lines.push(`  ${pad("Model", width.model)}${pad("Context", width.context)}Reasoning`)

  const window = windowOf(state.cursor.models, entries.length, Math.max(2, room - 3))
  let lastGroup = ""
  for (let index = window.start; index < window.end; index++) {
    const entry = entries[index]
    if (!entry) continue
    const selected = index === state.cursor.models
    if (entry.groupStart && entry.providerLabel !== undefined && entry.providerLabel !== lastGroup) {
      lines.push(`  ${entry.providerLabel}`)
      lastGroup = entry.providerLabel
    }
    lines.push(
      marker(selected, false) +
        pad(truncate(labelOf(entry), width.model - 1), width.model) +
        pad(entry.kind === "inherit" ? "-" : formatContext(entry.model?.contextWindow), width.context) +
        reasoningCell(entry, selected, cycle, state.draftVariant),
    )
  }
  if (entries.length === 1 && state.filter.length > 0) {
    lines.push(`  Nothing matches "${state.filter}". Press / to change the filter, or m to type a model.`)
  }
  if (window.end < entries.length || window.start > 0) {
    lines.push(`  ${window.start + 1}-${window.end} of ${entries.length}`)
  }

  if (state.entry?.field === "filter") {
    lines.push("", `${pad("Filter", GUTTER)}${state.entry.value}_`)
  }
  if (state.entry?.field === "model") {
    lines.push(
      "",
      `${pad("Model", GUTTER)}${state.entry.value}_`,
      `${pad("", GUTTER)}written provider/model, e.g. anthropic/claude-opus-4-5; empty to inherit`,
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
 */
function reasoningCell(
  entry: PickerEntry,
  selected: boolean,
  cycle: { values: Array<string | undefined>; known: boolean },
  draft: string | undefined,
): string {
  if (entry.kind === "inherit") return selected ? "no model, so no effort" : "-"
  const variants = entry.model?.variants ?? { kind: "unknown" }
  if (!selected) {
    switch (variants.kind) {
      case "unknown":
        return "unknown"
      case "none":
        return "takes no effort"
      case "efforts":
        return variants.values.length === 1
          ? variants.values[0]!
          : `${variants.values[0]}-${variants.values[variants.values.length - 1]}`
    }
  }
  if (variants.kind === "none") return "this model takes no reasoning effort"
  if (cycle.values.length <= 1) return "this model takes no reasoning effort"
  // No "(suggested)" suffix here even when the scale is a guess: the note line
  // under the table already says it in a full sentence, and repeating it costs
  // the twelve columns that make the widest scale fit at all.
  return cycle.values
    .map((value) => {
      const text = value ?? "off"
      return value === draft ? `[${text}]` : text
    })
    .join(" ")
}

/**
 * Findings for what the user is looking at, rendered verbatim.
 *
 * The sentences come straight out of `diagnoseSeats` and are not reworded
 * here. One component decides what is wrong with a seats config and it is not
 * this one — otherwise the installer, the daemon and this UI drift into three
 * different opinions about the same file.
 */
function notes(state: ConfigUIState, issues: SeatIssue[], columns: number): string[] {
  const scope = state.employeeId
  // Drilled into an employee, only their findings and the config-wide ones are
  // on screen. From the list, everything is, because the list is where a
  // problem on a row you are not looking at still needs to be visible.
  const shown =
    scope === undefined || state.view === "employees"
      ? issues
      : issues.filter((issue) => issue.employeeId === undefined || issue.employeeId === scope)
  if (state.status.length === 0 && shown.length === 0) return []

  const lines = [""]
  if (state.status.length > 0) lines.push(wrapAt(state.status, columns, "  "))
  for (const issue of shown.slice(0, 4)) {
    lines.push(wrapAt(`${issue.severity}: ${issue.message}`, columns, "  "))
  }
  if (shown.length > 4) lines.push(`  ...and ${shown.length - 4} more; see observer doctor.`)
  return lines.flatMap((line) => line.split("\n"))
}

function hints(state: ConfigUIState): string[] {
  if (state.confirmQuit) return ["Unsaved changes.  s save and quit   q quit anyway   esc keep editing"]
  if (state.entry !== undefined) return ["enter apply   esc cancel"]
  switch (state.view) {
    case "employees":
      return ["up/down move   enter configure   c toggle seat control   s save   esc quit"]
    case "employee":
      return ["up/down move   enter change   s save   esc back"]
    case "models":
      return ["up/down move   left/right effort   tab vendor   / filter   m type a model   enter select   esc back"]
  }
}

/**
 * Plain-text seat report for a pipe, a CI log or `observer config | less`.
 *
 * Raw mode on a non-TTY either throws or hangs forever, so the interactive
 * path is never entered there. Reporting instead of refusing follows
 * `observer doctor`: the command still answers the question you asked, it just
 * cannot take your keystrokes.
 */
export function renderReport(seats: SeatsConfig, roster: EmployeeRow[]): string[] {
  const diagnosis = diagnoseSeats(seats)
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

  if (diagnosis.issues.length > 0) {
    lines.push("", "Notes")
    for (const issue of diagnosis.issues) lines.push(`  ${issue.severity}: ${issue.message}`)
  }
  lines.push("", "Run `observer config` in a terminal to change any of this.")
  return lines
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

/** `>` for the cursor, `!` for a seat `diagnoseSeats` has something to say about. */
function marker(selected: boolean, flagged: boolean): string {
  return `${selected ? ">" : " "}${flagged ? "!" : " "}`
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

function truncate(value: string, width: number): string {
  if (width <= 0) return ""
  if (value.length <= width) return value
  return width >= 8 ? `${value.slice(0, width - 3)}...` : value.slice(0, width)
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width, " ")
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

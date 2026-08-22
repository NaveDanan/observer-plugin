import type { SeatSpec, SeatsConfig } from "@observer-ai/daemon"
import type { EmployeeSkill } from "@observer-ai/roster"
import { type ModelInfo, groupByProvider, variantsFor } from "./models.js"

/**
 * The whole behaviour of `observer config`, as a pure function of state and a
 * keystroke.
 *
 * No I/O lives here, and none may. Everything a user can do — move, drill in,
 * cycle an effort, type a model, clear a seat, flip `control` — is a
 * transition in this file, so the entire feature is testable as
 * `keys.reduce(reduce, initialState(...))` with an assertion on the result.
 * The terminal shell is then small enough that leaving it untested is honest
 * rather than convenient.
 *
 * Saving is not done here. The reducer raises `request`, the shell performs
 * it and reports back through `applied`. That keeps "the user asked to save"
 * (a state transition, tested) apart from "the file was written" (I/O, not).
 */

/**
 * Views, outside-in.
 *
 * The UI opens on the `menu` — the organised top level where seat control,
 * the roster and leaving all live as named rows instead of hidden hotkeys.
 * Every deeper screen unwinds one level per esc, so navigation has one rule:
 * esc takes you back exactly one step, and only the menu can end the session.
 */
export type ConfigView = "menu" | "employees" | "employee" | "models"

/** One actionable row of the main menu, in display order. */
export type MenuRowKind = "control" | "employees" | "save" | "exit"

/**
 * The menu's rows for the current state.
 *
 * Derived rather than stored, for the same reason `pickerEntries` is: the
 * reducer and the renderer cannot disagree about what row 2 is. `Save & exit`
 * appears only when there are unsaved changes, so the menu never offers an
 * inert action — and the row indices below it shift, which is why activation
 * always re-reads this list rather than trusting the remembered cursor.
 */
export function menuRows(state: ConfigUIState): MenuRowKind[] {
  const rows: MenuRowKind[] = ["control", "employees"]
  if (state.dirty) rows.push("save")
  rows.push("exit")
  return rows
}

/** The roster projected down to what the list view draws. */
export interface EmployeeRow {
  id: string
  name: string
  role: string
}

/** Rows of the per-employee view, in display order. */
export const EMPLOYEE_ROWS = ["model", "skills", "reset"] as const
export type EmployeeRowKind = (typeof EMPLOYEE_ROWS)[number]

export type EntryField = "model" | "skills" | "filter"

export interface EntryState {
  field: EntryField
  value: string
}

/** Something only the shell can do. Drained by `applied`. */
export type ConfigRequest = "save" | "quit"

export interface ConfigUIState {
  view: ConfigView
  /** The working copy. Never written to disk until the user asks. */
  seats: SeatsConfig
  roster: EmployeeRow[]
  models: ModelInfo[]
  /** One cursor per view, so backing out and re-entering keeps your place. */
  cursor: Record<ConfigView, number>
  /** The employee the `employee` and `models` views are scoped to. */
  employeeId?: string
  /**
   * The effort the picker will commit alongside the highlighted model.
   *
   * Held on the picker rather than on the seat because effort is meaningless
   * apart from a model: OpenCode applies a variant only to an agent's own
   * configured model. Committing the two together is what makes
   * "effort without a model" unreachable through this UI.
   */
  draftVariant?: string
  entry?: EntryState
  /** Substring filter over the model picker. */
  filter: string
  /** Whether quitting is currently waiting on an answer about unsaved edits. */
  confirmQuit: boolean
  /** Set when the pending save was asked for on the way out. */
  quitAfterSave: boolean
  dirty: boolean
  request?: ConfigRequest
  /** One line of feedback under the header. Cleared by the next keystroke. */
  status: string
}

/** A keypress, in `node:readline`'s own shape so the shell forwards verbatim. */
export interface Key {
  name?: string
  sequence?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}

export interface InitialInput {
  seats: SeatsConfig
  roster: EmployeeRow[]
  models: ModelInfo[]
  /** Shown once on arrival, e.g. what the model catalogue managed to read. */
  welcome?: string
}

export function initialState(input: InitialInput): ConfigUIState {
  return {
    view: "menu",
    seats: cloneSeats(input.seats),
    roster: input.roster,
    models: input.models,
    cursor: { menu: 0, employees: 0, employee: 0, models: 0 },
    filter: "",
    confirmQuit: false,
    quitAfterSave: false,
    dirty: false,
    status: input.welcome ?? "",
  }
}

/** One row of the model picker. Index 0 is always "inherit". */
export interface PickerEntry {
  kind: "inherit" | "model"
  model?: ModelInfo
  /** First model of its provider: the renderer draws a header above it. */
  groupStart: boolean
  providerLabel?: string
}

/**
 * The picker's rows for the current filter.
 *
 * Derived rather than stored so the reducer and the renderer can never
 * disagree about what row 7 is — the bug class that makes hand-rolled list
 * UIs miserable.
 *
 * A model the seat already names but the catalogue does not carry gets a row
 * of its own. Without it, a user on a provider models.dev has not indexed
 * would open the picker and see the cursor sitting on "inherit", which says
 * their configured model is not there at all.
 */
export function pickerEntries(state: ConfigUIState): PickerEntry[] {
  const needle = state.filter.trim().toLowerCase()
  const matches = needle.length === 0 ? state.models : state.models.filter((model) => hits(model, needle))
  const entries: PickerEntry[] = [{ kind: "inherit", groupStart: false }]

  const configured = seatOf(state, state.employeeId)?.model
  if (typeof configured === "string" && configured.length > 0 && !state.models.some((m) => m.id === configured)) {
    const model = strayModel(configured)
    if (needle.length === 0 || hits(model, needle)) {
      entries.push({ kind: "model", model, groupStart: true, providerLabel: model.providerLabel })
    }
  }

  for (const group of groupByProvider(matches)) {
    group.models.forEach((model, index) => {
      entries.push({ kind: "model", model, groupStart: index === 0, providerLabel: group.label })
    })
  }
  return entries
}

function hits(model: ModelInfo, needle: string): boolean {
  return model.id.toLowerCase().includes(needle) || model.label.toLowerCase().includes(needle)
}

/** A stand-in for a configured model the catalogue never described. */
function strayModel(id: string): ModelInfo {
  const slash = id.indexOf("/")
  const provider = slash > 0 ? id.slice(0, slash) : id
  return {
    id,
    provider,
    providerLabel: `${provider} (not in the catalogue)`,
    label: slash >= 0 ? id.slice(slash + 1) : id,
    // Not in the catalogue, so nothing is known about its efforts — which is
    // not the same as knowing it has none. The picker offers the suggestion
    // list and says the host has the final say.
    variants: { kind: "unknown" },
    known: false,
  }
}

/**
 * The efforts `left`/`right` cycles through for the highlighted row.
 *
 * `undefined` leads, and it is the only option on the "inherit" row: with no
 * model there is no effort to set, so the control has nothing to offer rather
 * than offering something inert.
 */
export function effortCycle(state: ConfigUIState): { values: Array<string | undefined>; known: boolean } {
  const entry = pickerEntries(state)[state.cursor.models]
  if (!entry || entry.kind === "inherit") return { values: [undefined], known: true }
  const { values, known } = variantsFor(state.models, entry.model?.id)
  return { values: [undefined, ...values], known }
}

export function currentEmployee(state: ConfigUIState): EmployeeRow | undefined {
  if (state.employeeId === undefined) return undefined
  return state.roster.find((row) => row.id === state.employeeId)
}

export function seatOf(state: ConfigUIState, id: string | undefined): SeatSpec | undefined {
  if (id === undefined) return undefined
  return state.seats.employees[id]
}

/**
 * Folds one keypress into the state.
 *
 * Returns the same object when nothing changed, so the shell can skip a
 * repaint on a key that did nothing.
 */
export function reduce(state: ConfigUIState, key: Key): ConfigUIState {
  // Ctrl-C is the one key that outranks every mode, including a half-typed
  // model and an unanswered quit prompt. A user reaching for it wants out.
  if (key.ctrl === true && key.name === "c") return { ...state, request: "quit", status: "" }

  const base = state.status === "" ? state : { ...state, status: "" }
  if (base.entry !== undefined) return reduceEntry(base, key)
  if (base.confirmQuit) return reduceConfirm(base, key)
  switch (base.view) {
    case "menu":
      return reduceMenu(base, key)
    case "employees":
      return reduceEmployees(base, key)
    case "employee":
      return reduceEmployee(base, key)
    case "models":
      return reduceModels(base, key)
  }
}

/**
 * The top level: named rows instead of hidden keys.
 *
 * Seat control is the first row because it is the first thing a new user has
 * to decide — without it every model choice below is inert. Activation is by
 * `enter` or `space`, and the row list is re-derived on every keystroke so a
 * save that removes the `Save & exit` row can never leave the cursor pointing
 * at a ghost.
 */
function reduceMenu(state: ConfigUIState, key: Key): ConfigUIState {
  if (key.name === "c") return toggleSeatControl(state)
  if (key.name === "s") return requestSave(state)
  if (isEscape(key) || key.name === "q") return requestQuit(state)

  const rows = menuRows(state)
  // A save drops the `Save & exit` row, so a remembered cursor can outlive the
  // row it was pointing at. Clamping here means neither moving nor activating
  // can act on a row that is no longer on screen.
  const at = Math.min(state.cursor.menu, rows.length - 1)
  const clamped: ConfigUIState = { ...state, cursor: { ...state.cursor, menu: at } }
  if (isUp(key)) return moveCursor(clamped, "menu", -1, rows.length)
  if (isDown(key)) return moveCursor(clamped, "menu", 1, rows.length)

  if (isEnter(key) || isSpace(key)) {
    switch (rows[at]) {
      case "control":
        return toggleSeatControl(clamped)
      case "employees":
        return { ...clamped, view: "employees", cursor: { ...clamped.cursor, employees: 0 } }
      case "save": {
        // The row says "Save & exit", so it does both: the shell performs the
        // save and `applied` turns the pending quit into a request, which is
        // the same handshake the confirm-on-the-way-out prompt uses. A save
        // that fails cancels the quit, there as here.
        const saving = requestSave(clamped)
        return saving.request === "save" ? { ...saving, quitAfterSave: true } : saving
      }
      case "exit":
        return requestQuit(clamped)
    }
  }
  return state
}

/** One place owns the flag flip and the sentence that explains it. */
function toggleSeatControl(state: ConfigUIState): ConfigUIState {
  const control = !state.seats.control
  return {
    ...state,
    seats: { ...state.seats, control },
    dirty: true,
    status: control
      ? "Seat control on: models and efforts will be applied. Save to write it."
      : "Seat control off: models and efforts are inert. Skills still apply.",
  }
}

/**
 * Clears a request the shell has carried out, and folds the outcome back in.
 *
 * The "save on the way out" handshake lives here rather than in the shell so
 * that the rule — a failed save cancels the quit and keeps the user's edits on
 * screen — is covered by the reducer's tests instead of by a comment in an
 * untested file.
 */
export function applied(state: ConfigUIState, outcome: { saved?: boolean; status?: string }): ConfigUIState {
  const next: ConfigUIState = { ...state, status: outcome.status ?? state.status }
  delete next.request
  if (outcome.saved !== true) {
    // The edits are still only in memory, so the prompt that offered to save
    // them must stay up.
    return next
  }
  next.dirty = false
  next.confirmQuit = false
  if (next.quitAfterSave) {
    next.quitAfterSave = false
    next.request = "quit"
  }
  return next
}

function reduceEmployees(state: ConfigUIState, key: Key): ConfigUIState {
  if (isUp(key)) return moveCursor(state, "employees", -1, state.roster.length)
  if (isDown(key)) return moveCursor(state, "employees", 1, state.roster.length)

  if (isEnter(key)) {
    const row = state.roster[state.cursor.employees]
    if (!row) return state
    return { ...state, view: "employee", employeeId: row.id, cursor: { ...state.cursor, employee: 0 } }
  }

  if (key.name === "c") return toggleSeatControl(state)

  if (key.name === "s") return requestSave(state)
  if (key.name === "q") return requestQuit(state)
  // esc unwinds one level; only the menu can end the session.
  if (isEscape(key)) return { ...state, view: "menu" }
  return state
}

function reduceEmployee(state: ConfigUIState, key: Key): ConfigUIState {
  if (isUp(key)) return moveCursor(state, "employee", -1, EMPLOYEE_ROWS.length)
  if (isDown(key)) return moveCursor(state, "employee", 1, EMPLOYEE_ROWS.length)
  if (isEscape(key)) return { ...state, view: "employees" }
  if (key.name === "s") return requestSave(state)

  if (isEnter(key)) {
    const row = EMPLOYEE_ROWS[state.cursor.employee]
    const seat = seatOf(state, state.employeeId)
    if (row === "model") return openPicker(state, seat)
    if (row === "skills") {
      return { ...state, entry: { field: "skills", value: skillNames(seat).join(", ") } }
    }
    if (row === "reset") return resetSeat(state)
  }
  return state
}

function reduceModels(state: ConfigUIState, key: Key): ConfigUIState {
  const entries = pickerEntries(state)

  if (isUp(key)) return clampVariant({ ...state, cursor: step(state.cursor, "models", -1, entries.length) }, entries)
  if (isDown(key)) return clampVariant({ ...state, cursor: step(state.cursor, "models", 1, entries.length) }, entries)
  if (key.name === "left") return cycleEffort(state, -1)
  if (key.name === "right") return cycleEffort(state, 1)
  if (key.name === "tab") return jumpGroup(state, entries, key.shift === true ? -1 : 1)
  if (key.name === "/") return { ...state, entry: { field: "filter", value: state.filter } }
  if (key.name === "m") return { ...state, entry: { field: "model", value: modelOf(seatOf(state, state.employeeId)) } }
  if (isEscape(key)) return { ...state, view: "employee" }

  if (isEnter(key)) {
    const entry = entries[state.cursor.models]
    if (!entry) return state
    if (entry.kind === "inherit") return assignModel(state, undefined, undefined)
    return assignModel(state, entry.model?.id, state.draftVariant)
  }
  return state
}

function reduceEntry(state: ConfigUIState, key: Key): ConfigUIState {
  const entry = state.entry
  if (entry === undefined) return state

  if (isEscape(key)) {
    const next = { ...state }
    delete next.entry
    return next
  }

  if (key.name === "backspace") {
    return { ...state, entry: { ...entry, value: entry.value.slice(0, -1) } }
  }

  if (isEnter(key)) {
    const next: ConfigUIState = { ...state }
    delete next.entry
    if (entry.field === "filter") {
      // The filter changes which row index means what, so the cursor goes
      // back to the top rather than landing somewhere arbitrary.
      return { ...next, filter: entry.value, cursor: { ...next.cursor, models: 0 } }
    }
    if (entry.field === "skills") return setSkills(next, entry.value)
    const typed = entry.value.trim()
    if (typed.length === 0) return assignModel(next, undefined, undefined)
    return assignModel(next, typed, next.draftVariant)
  }

  const char = printable(key)
  if (char === undefined) return state
  return { ...state, entry: { ...entry, value: entry.value + char } }
}

function reduceConfirm(state: ConfigUIState, key: Key): ConfigUIState {
  if (key.name === "s") return { ...state, request: "save", quitAfterSave: true, status: "Saving..." }
  if (key.name === "q") return { ...state, request: "quit" }
  if (isEscape(key)) return { ...state, confirmQuit: false }
  return state
}

function openPicker(state: ConfigUIState, seat: SeatSpec | undefined): ConfigUIState {
  const model = typeof seat?.model === "string" ? seat.model : undefined
  const next: ConfigUIState = { ...state, view: "models", filter: "" }
  if (typeof seat?.variant === "string") next.draftVariant = seat.variant
  else delete next.draftVariant
  // Land on the model the seat already names, so opening the picker to change
  // only the effort does not first make the user hunt for where they are.
  const entries = pickerEntries(next)
  const index = model === undefined ? 0 : entries.findIndex((entry) => entry.model?.id === model)
  next.cursor = { ...state.cursor, models: index >= 0 ? index : 0 }
  return clampVariant(next, entries)
}

/**
 * Writes model and effort together, and clears the effort when the model goes.
 *
 * The pairing is deliberate. `diagnoseSeats` warns about a variant with no
 * model because hand-edited files produce them; this UI must never be the
 * thing that produces one.
 */
function assignModel(state: ConfigUIState, model: string | undefined, variant: string | undefined): ConfigUIState {
  const id = state.employeeId
  if (id === undefined) return state
  const next = updateSeat(state, id, (seat) => {
    const spec: SeatSpec = { ...seat }
    if (model === undefined) {
      delete spec.model
      delete spec.variant
    } else {
      spec.model = model
      if (variant === undefined) delete spec.variant
      else spec.variant = variant
    }
    return spec
  })
  return {
    ...next,
    view: "employee",
    status:
      model === undefined
        ? "Model cleared. This employee inherits the session's model, and the effort was dropped with it."
        : `Model set to ${model}${variant === undefined ? "" : ` at ${variant} effort`}.`,
  }
}

function setSkills(state: ConfigUIState, raw: string): ConfigUIState {
  const id = state.employeeId
  if (id === undefined) return state
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  const next = updateSeat(state, id, (seat) => {
    const spec: SeatSpec = { ...seat }
    if (names.length === 0) delete spec.skills
    else spec.skills = names.map((name): EmployeeSkill => ({ name, description: "" }))
    return spec
  })
  return {
    ...next,
    status:
      names.length === 0
        ? "Skills cleared."
        : `${names.length} skill${names.length === 1 ? "" : "s"} added to this employee's profile. Skills apply whether or not seat control is on.`,
  }
}

function resetSeat(state: ConfigUIState): ConfigUIState {
  const id = state.employeeId
  if (id === undefined) return state
  if (state.seats.employees[id] === undefined) return { ...state, status: "This employee has no seat to reset." }
  const employees = { ...state.seats.employees }
  delete employees[id]
  return {
    ...state,
    seats: { ...state.seats, employees },
    dirty: true,
    status: "Seat cleared: model, effort and skills all back to defaults.",
  }
}

/**
 * Applies an edit to one seat, dropping the seat when nothing is left.
 *
 * Emptiness is measured on the whole spec, not on the fields Observer reads,
 * so a seat carrying a hand-written `temperature` survives having its model
 * cleared. Deleting a user's key because we do not render it would be the
 * exact data loss `SeatSpec`'s index signature exists to prevent.
 */
function updateSeat(state: ConfigUIState, id: string, edit: (seat: SeatSpec) => SeatSpec): ConfigUIState {
  const employees = { ...state.seats.employees }
  const spec = edit(employees[id] ?? {})
  if (Object.keys(spec).length === 0) delete employees[id]
  else employees[id] = spec
  return { ...state, seats: { ...state.seats, employees }, dirty: true }
}

function cycleEffort(state: ConfigUIState, direction: number): ConfigUIState {
  const { values, known } = effortCycle(state)
  if (values.length <= 1) {
    const entry = pickerEntries(state)[state.cursor.models]
    return {
      ...state,
      status:
        entry?.kind === "inherit"
          ? "Reasoning effort needs a model: OpenCode applies a variant only to an agent's own configured model."
          : `${entry?.model?.label ?? "This model"} takes no reasoning effort, so there is nothing to cycle through.`,
    }
  }
  const at = values.indexOf(state.draftVariant)
  const index = wrap(at + direction, values.length)
  const chosen = values[index]
  const next: ConfigUIState = { ...state }
  if (chosen === undefined) delete next.draftVariant
  else next.draftVariant = chosen
  if (!known) {
    next.status = `Observer does not know which efforts this model accepts, so these are suggestions - the host has the final say.`
  }
  return next
}

/**
 * Drops an effort the highlighted model does not declare.
 *
 * Moving the cursor from a model that offers `max` to one that stops at `high`
 * must not leave `max` armed: the host rejects a variant its model does not
 * list, and it rejects the whole delegation, not just the variant.
 */
function clampVariant(state: ConfigUIState, entries: PickerEntry[]): ConfigUIState {
  const variant = state.draftVariant
  if (variant === undefined) return state
  const entry = entries[state.cursor.models]
  if (!entry) return state
  if (entry.kind === "inherit") {
    const next = { ...state }
    delete next.draftVariant
    return next
  }
  const { values, known } = variantsFor(state.models, entry.model?.id)
  if (!known || values.includes(variant)) return state
  const next = { ...state }
  delete next.draftVariant
  next.status = `${entry.model?.label ?? "That model"} does not offer "${variant}" effort, so the effort was cleared.`
  return next
}

function jumpGroup(state: ConfigUIState, entries: PickerEntry[], direction: number): ConfigUIState {
  const starts = entries.flatMap((entry, index) => (entry.groupStart ? [index] : []))
  if (starts.length === 0) return state
  const at = state.cursor.models
  const target =
    direction > 0
      ? (starts.find((index) => index > at) ?? starts[0]!)
      : ([...starts].reverse().find((index) => index < at) ?? starts[starts.length - 1]!)
  return clampVariant({ ...state, cursor: { ...state.cursor, models: target } }, entries)
}

function requestSave(state: ConfigUIState): ConfigUIState {
  if (!state.dirty) return { ...state, status: "Nothing to save." }
  return { ...state, request: "save", status: "Saving..." }
}

function requestQuit(state: ConfigUIState): ConfigUIState {
  if (state.dirty) return { ...state, confirmQuit: true }
  return { ...state, request: "quit" }
}

function moveCursor(state: ConfigUIState, view: ConfigView, direction: number, length: number): ConfigUIState {
  if (length === 0) return state
  return { ...state, cursor: step(state.cursor, view, direction, length) }
}

/** Wrapping, because these lists are short and a dead end at the edge is worse. */
function step(
  cursor: Record<ConfigView, number>,
  view: ConfigView,
  direction: number,
  length: number,
): Record<ConfigView, number> {
  if (length === 0) return cursor
  return { ...cursor, [view]: wrap(cursor[view] + direction, length) }
}

function wrap(index: number, length: number): number {
  return ((index % length) + length) % length
}

function modelOf(seat: SeatSpec | undefined): string {
  return typeof seat?.model === "string" ? seat.model : ""
}

function skillNames(seat: SeatSpec | undefined): string[] {
  return Array.isArray(seat?.skills) ? seat.skills.map((skill) => skill.name) : []
}

function isUp(key: Key): boolean {
  return key.name === "up" || key.name === "k"
}

function isDown(key: Key): boolean {
  return key.name === "down" || key.name === "j"
}

function isEnter(key: Key): boolean {
  return key.name === "return" || key.name === "enter"
}

/** Space activates a menu row as well as enter, the way every list UI does. */
function isSpace(key: Key): boolean {
  return key.name === "space"
}

function isEscape(key: Key): boolean {
  return key.name === "escape" || key.name === "esc"
}

/**
 * The character a key contributes to a text field, if any.
 *
 * Control sequences arrive with multi-character `sequence` values, so length
 * is the filter; `ctrl`/`meta` are excluded so `ctrl+a` cannot end up inside a
 * model name.
 */
function printable(key: Key): string | undefined {
  if (key.ctrl === true || key.meta === true) return undefined
  const sequence = key.sequence
  if (sequence === undefined || sequence.length !== 1) return undefined
  const code = sequence.charCodeAt(0)
  if (code < 0x20 || code === 0x7f) return undefined
  return sequence
}

function cloneSeats(seats: SeatsConfig): SeatsConfig {
  const employees: Record<string, SeatSpec> = {}
  for (const [id, spec] of Object.entries(seats.employees ?? {})) employees[id] = { ...spec }
  return { control: seats.control === true, employees }
}

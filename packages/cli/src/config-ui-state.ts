import {
  LEGACY_TARGET_ID,
  OPENCODE_VARIANT_OPTION,
  type CodexAvailableSkill,
  type CodexSkillInventory,
  type CatalogueModel,
  type HostCapabilities,
  type ModelCatalogue,
  type ModelOptionDescriptor,
  readOpencodeTarget,
  seatTargets,
  type SeatSpec,
  type SeatTarget,
  type SeatTargetOption,
  type SeatsConfig,
} from "@observer-ai/daemon"
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
export type ConfigView =
  | "menu"
  | "employees"
  | "employee"
  | "targets"
  | "models"
  | "options"
  | "skills"
  /** Which host/profile the default is being chosen for. Scoped to nobody. */
  | "default-target"
  /** The default-model picker. Same table as `models`, scoped to nobody. */
  | "default"
  /** Who receives the pick made in `default`. */
  | "apply"

/** One actionable row of the main menu, in display order. */
export type MenuRowKind = "control" | "employees" | "default-model" | "skills" | "save" | "exit"

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
  const rows: MenuRowKind[] = ["control", "employees", "default-model", "skills"]
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
export const TARGET_EMPLOYEE_ROWS = ["targets", "skills", "reset"] as const
export type EmployeeRowKind = (typeof EMPLOYEE_ROWS)[number]
export type TargetEmployeeRowKind = (typeof TARGET_EMPLOYEE_ROWS)[number]

export type EntryField = "model" | "skills" | "filter"

export interface EntryState {
  field: EntryField
  value: string
}

/** Something only the shell can do. Drained by `applied`. */
export type ConfigRequest = "save" | "quit" | "catalogue"

export interface TargetProfile {
  id: string
  host: string
  hostLabel: string
  profileLabel: string
  capabilities: HostCapabilities
}

export interface TargetRow {
  id: string
  host: string
  hostLabel: string
  profileLabel: string
  capabilities?: HostCapabilities
  configured: boolean
  target?: SeatTarget
}

export interface TargetControl {
  label: "applied" | "experimental" | "configured" | "not applied to children"
  effective: boolean
}

/**
 * A committed default-model pick, waiting on the answer to "who gets it".
 *
 * Held apart from `seats` because nothing has been edited yet: the choice
 * becomes seat targets only when an `apply` row is activated, and esc throws
 * it away without marking anything dirty.
 */
export interface DefaultChoice {
  model: string
  /** The reasoning effort armed in the picker, applied alongside the model. */
  variant?: string
  /** The host/profile the default is written to. Absent means the legacy OpenCode target. */
  targetId?: string
  /** The host that owns `targetId`, stored beside the model like any other target. */
  host?: string
  /** Options armed in the target picker, committed with the model. */
  options?: SeatTargetOption[]
}

/** The two scopes the apply view offers, in display order. */
export const DEFAULT_APPLY_ROWS = ["unseated", "all"] as const
export type DefaultApplyRowKind = (typeof DEFAULT_APPLY_ROWS)[number]

export interface ConfigUIState {
  view: ConfigView
  /** The working copy. Never written to disk until the user asks. */
  seats: SeatsConfig
  roster: EmployeeRow[]
  models: ModelInfo[]
  /** Spawn-free host/profile directory. Empty keeps the legacy OpenCode-only flow. */
  profiles: TargetProfile[]
  /** Preloaded for Copilot at launch; other targets load when opened. */
  catalogues: Record<string, ModelCatalogue>
  /** Enabled skills Codex resolved from this project and the user's global roots. */
  availableSkills: CodexAvailableSkill[]
  skillWarnings: string[]
  /** Whether every Codex spawn receives `availableSkills`. Defaults on. */
  passAllSkills: boolean
  /** One cursor per view, so backing out and re-entering keeps your place. */
  cursor: Record<ConfigView, number>
  /** The employee the `employee` and `models` views are scoped to. */
  employeeId?: string
  targetId?: string
  /**
   * The effort the picker will commit alongside the highlighted model.
   *
   * Held on the picker rather than on the seat because effort is meaningless
   * apart from a model: OpenCode applies a variant only to an agent's own
   * configured model. Committing the two together is what makes
   * "effort without a model" unreachable through this UI.
   */
  draftVariant?: string
  /** Target options chosen in the model picker, committed together on enter. */
  draftTargetOptions: SeatTargetOption[]
  /** The pick made in the `default` view, applied by an `apply` view row. */
  defaultChoice?: DefaultChoice
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
  profiles?: TargetProfile[]
  catalogues?: Record<string, ModelCatalogue>
  skillInventory?: CodexSkillInventory
  passAllSkills?: boolean
  /** Shown once on arrival, e.g. what the model catalogue managed to read. */
  welcome?: string
}

export function initialState(input: InitialInput): ConfigUIState {
  return {
    view: "menu",
    seats: cloneSeats(input.seats),
    roster: input.roster,
    models: input.models,
    profiles: input.profiles ?? [],
    catalogues: input.catalogues ?? {},
    availableSkills: input.skillInventory?.skills ?? [],
    skillWarnings: input.skillInventory?.warnings ?? [],
    passAllSkills: input.passAllSkills !== false,
    cursor: { menu: 0, employees: 0, employee: 0, targets: 0, models: 0, options: 0, skills: 0, "default-target": 0, default: 0, apply: 0 },
    draftTargetOptions: [],
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

  const configured =
    state.targetId === undefined ? modelOf(seatOf(state, state.employeeId)) : (targetModel(currentTarget(state)) ?? "")
  if (configured.length > 0 && !state.models.some((m) => m.id === configured)) {
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
  if (state.targetId === undefined) return entries

  const configuredIndex = entries.findIndex(
    (entry) => entry.kind === "model" && entry.model?.id === configured,
  )
  const configuredEntry = configuredIndex > 0 ? entries[configuredIndex] : undefined
  const others = entries.filter((_, index) => index > 0 && index !== configuredIndex)
  return [
    { kind: "inherit", groupStart: true, providerLabel: "Recommended models" },
    ...(configuredEntry === undefined
      ? []
      : [{ ...configuredEntry, groupStart: false, providerLabel: "Recommended models" }]),
    ...others.map((entry, index) => ({
      ...entry,
      groupStart: index === 0,
      providerLabel: "Other models",
    })),
  ]
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

export function employeeRows(state: ConfigUIState): ReadonlyArray<EmployeeRowKind | TargetEmployeeRowKind> {
  return state.profiles.length > 0 ? TARGET_EMPLOYEE_ROWS : EMPLOYEE_ROWS
}

export function targetRows(state: ConfigUIState): TargetRow[] {
  const seat = seatOf(state, state.employeeId)
  const configured = seatTargets(seat)
  const rows: TargetRow[] = state.profiles.map((profile) => {
    const isConfigured = Object.hasOwn(configured, profile.id)
    const target = isConfigured ? configured[profile.id] : undefined
    const storedHost =
      target && typeof target === "object" && !Array.isArray(target) && typeof target.host === "string"
        ? target.host
        : profile.host
    const mismatched = isConfigured && storedHost !== profile.host
    return {
      id: profile.id,
      host: storedHost,
      hostLabel: mismatched ? storedHost : profile.hostLabel,
      profileLabel: profile.profileLabel,
      ...(mismatched ? {} : { capabilities: profile.capabilities }),
      configured: isConfigured,
      ...(isConfigured ? { target } : {}),
    }
  })
  const known = new Set(rows.map((row) => row.id))
  for (const id of Object.keys(configured).sort()) {
    if (known.has(id)) continue
    const target = configured[id]
    const host =
      target && typeof target === "object" && !Array.isArray(target) && typeof target.host === "string"
        ? target.host
        : targetHostFromId(id)
    rows.push({
      id,
      host,
      hostLabel: host,
      profileLabel: profileLabelFromId(id),
      configured: true,
      target,
    })
  }
  return rows
}

export function currentTargetRow(state: ConfigUIState): TargetRow | undefined {
  if (state.targetId === undefined) return undefined
  return targetRows(state).find((row) => row.id === state.targetId)
}

export function targetControl(row: TargetRow, enabled: boolean): TargetControl {
  const capabilities = row.capabilities
  const target = row.target
  const hasSetting =
    target &&
    typeof target === "object" &&
    !Array.isArray(target) &&
    ((typeof target.model === "string" && target.model.length > 0) ||
      (Array.isArray(target.options) && target.options.length > 0))
  if (row.configured && !hasSetting) return { label: "configured", effective: false }
  if (
    capabilities === undefined ||
    (capabilities.childModel === "unsupported" && capabilities.childReasoning === "unsupported")
  ) {
    return { label: "not applied to children", effective: false }
  }
  if (capabilities.childModel === "experimental" || capabilities.childReasoning === "experimental") {
    return { label: "experimental", effective: false }
  }
  if (!enabled) return { label: "configured", effective: false }
  return { label: "applied", effective: true }
}

export function targetDescriptors(state: ConfigUIState): ModelOptionDescriptor[] {
  const target = currentTarget(state)
  const model = targetModel(target)
  if (model === undefined || state.targetId === undefined) return []
  const catalogue = state.catalogues[state.targetId]
  return (catalogue?.models.find((entry) => entry.id === model)?.options ?? []).filter(
    (descriptor) => inlineTargetOption(descriptor) === undefined,
  )
}

export type InlineTargetOption = "reasoning" | "context"

export function inlineTargetOption(descriptor: ModelOptionDescriptor): InlineTargetOption | undefined {
  if (descriptor.type !== "select") return undefined
  const name = `${descriptor.id} ${descriptor.label}`.toLowerCase()
  if (name.includes("context")) return "context"
  if (name.includes("reasoning") || name.includes("effort") || descriptor.id === OPENCODE_VARIANT_OPTION) {
    return "reasoning"
  }
  return undefined
}

/**
 * Whether the highlighted row names a model this account may not run.
 *
 * An explicit `false` only. `undefined` means nobody asked — no host but
 * Copilot can answer, and even Copilot answers from a cache that a background
 * refresh fills — so treating it as "barred" would disable every picker in the
 * product until that cache warmed.
 */
export function barredEntry(entry: PickerEntry | undefined): boolean {
  return entry?.kind === "model" && entry.model?.available === false
}

/** Why a row is refused, named so the user knows it is not a bug. */
export function barredStatus(entry: PickerEntry | undefined): string {
  const model = entry?.model?.label ?? entry?.model?.id ?? "That model"
  return `${model} is not available to your account, so it cannot be selected. The host lists it, but your plan or your organisation's policy does not grant it.`
}

export function targetPickerDescriptor(
  state: ConfigUIState,
  kind: InlineTargetOption,
  entry: PickerEntry | undefined = pickerEntries(state)[state.cursor.models],
): ModelOptionDescriptor | undefined {
  if (entry?.kind !== "model" || state.targetId === undefined) return undefined
  const model = state.catalogues[state.targetId]?.models.find((candidate) => candidate.id === entry.model?.id)
  return model?.options.find((descriptor) => inlineTargetOption(descriptor) === kind)
}

export function targetPickerOptionValue(
  state: ConfigUIState,
  descriptor: ModelOptionDescriptor,
): string | undefined {
  const explicit = state.draftTargetOptions.find((option) => option.id === descriptor.id)?.value
  if (typeof explicit === "string") return explicit
  return descriptorValue(descriptor)
}

/**
 * What a descriptor says about itself, with no draft laid over it.
 *
 * The draft is keyed by option id, and a host reuses one id across its whole
 * model list — `effortLevel` is the same string on every Copilot model. Read
 * on a row the cursor is not sitting on, the draft therefore answers for the
 * wrong model: arming `high` on one row used to paint `high` down the entire
 * Reasoning column. Rows that are not the cursor's read the catalogue, and the
 * configured row reads what is actually saved for it.
 */
export function descriptorValue(descriptor: ModelOptionDescriptor): string | undefined {
  if (typeof descriptor.currentValue === "string") return descriptor.currentValue
  return descriptor.choices?.find((choice) => choice.isDefault === true)?.id
}

export function targetOptionValue(
  target: SeatTarget | undefined,
  descriptor: ModelOptionDescriptor,
): string | boolean | undefined {
  if (!Array.isArray(target?.options)) return undefined
  return target.options.find((option) => option?.id === descriptor.id)?.value
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
    case "targets":
      return reduceTargets(base, key)
    case "models":
      return reduceModels(base, key)
    case "options":
      return reduceOptions(base, key)
    case "skills":
      return reduceSkills(base, key)
    case "default-target":
      return reduceDefaultTarget(base, key)
    case "default":
      return reduceDefault(base, key)
    case "apply":
      return reduceApply(base, key)
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
      case "default-model":
        return openDefaultPicker(clamped)
      case "skills":
        return { ...clamped, view: "skills", cursor: { ...clamped.cursor, skills: 0 } }
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

function reduceSkills(state: ConfigUIState, key: Key): ConfigUIState {
  if (isEscape(key)) return { ...state, view: "menu" }
  const length = state.availableSkills.length + 1
  if (isUp(key)) return moveCursor(state, "skills", -1, length)
  if (isDown(key)) return moveCursor(state, "skills", 1, length)
  if ((isEnter(key) || isSpace(key)) && state.cursor.skills === 0) {
    const passAllSkills = !state.passAllSkills
    return {
      ...state,
      passAllSkills,
      dirty: true,
      status: passAllSkills
        ? "Pass All Skills is on. Every Codex subagent will receive this project's available skills after you save."
        : "Pass All Skills is off. Codex subagents will keep only skills configured directly on their employee seat.",
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

export function catalogueApplied(state: ConfigUIState, targetId: string, catalogue: ModelCatalogue): ConfigUIState {
  const next: ConfigUIState = {
    ...state,
    catalogues: { ...state.catalogues, [targetId]: catalogue },
    status: catalogue.warnings.join(" "),
  }
  if (next.request === "catalogue") delete next.request
  if (state.targetId !== targetId) return next
  next.models = catalogueModels(state, targetId, catalogue.models)
  return positionTargetPicker(next)
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
  const rows = employeeRows(state)
  if (isUp(key)) return moveCursor(state, "employee", -1, rows.length)
  if (isDown(key)) return moveCursor(state, "employee", 1, rows.length)
  if (isEscape(key)) return { ...state, view: "employees" }
  if (key.name === "s") return requestSave(state)

  if (isEnter(key)) {
    const row = rows[state.cursor.employee]
    const seat = seatOf(state, state.employeeId)
    if (row === "model") return openPicker(state, seat)
    if (row === "targets") {
      return {
        ...state,
        view: "targets",
        cursor: { ...state.cursor, targets: 0 },
      }
    }
    if (row === "skills") {
      return { ...state, entry: { field: "skills", value: skillNames(seat).join(", ") } }
    }
    if (row === "reset") return resetSeat(state)
  }
  return state
}

function reduceModels(state: ConfigUIState, key: Key): ConfigUIState {
  if (state.targetId !== undefined) return reduceTargetModels(state, key)
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

function reduceTargets(state: ConfigUIState, key: Key): ConfigUIState {
  const rows = targetRows(state)
  if (isUp(key)) return moveCursor(state, "targets", -1, rows.length)
  if (isDown(key)) return moveCursor(state, "targets", 1, rows.length)
  if (isEscape(key)) {
    const next = { ...state, view: "employee" as const }
    delete next.targetId
    return next
  }
  if (key.name === "s") return requestSave(state)
  if (key.name === "d" || key.name === "delete") return removeTargetAtCursor(state, rows)
  if (isEnter(key)) {
    const row = rows[state.cursor.targets]
    return row === undefined ? state : openTargetPicker(state, row)
  }
  return state
}

function reduceTargetModels(state: ConfigUIState, key: Key): ConfigUIState {
  const entries = pickerEntries(state)
  if (isUp(key)) return moveTargetModelCursor(state, entries, -1)
  if (isDown(key)) return moveTargetModelCursor(state, entries, 1)
  if (key.name === "left") return cycleTargetPickerOption(state, "reasoning", -1)
  if (key.name === "right") return cycleTargetPickerOption(state, "reasoning", 1)
  if (key.name === "tab" && key.shift === true) return moveTargetGroup(state, entries)
  if (key.name === "tab") return cycleTargetPickerOption(state, "context", 1)
  if (key.name === "/") return { ...state, entry: { field: "filter", value: state.filter } }
  if (key.name === "backspace") {
    return {
      ...state,
      filter: state.filter.slice(0, -1),
      cursor: { ...state.cursor, models: 0 },
      draftTargetOptions: [],
    }
  }
  if (isEscape(key)) return { ...state, view: "targets" }
  if (isEnter(key)) {
    const entry = entries[state.cursor.models]
    if (entry === undefined) return state
    if (entries.length === 1 && state.filter.trim().length > 0) {
      return assignTargetModel(state, state.filter.trim(), state.draftTargetOptions)
    }
    // A model the host lists but this account may not run. Refused here rather
    // than only greyed in the renderer, so the block survives a theme that
    // cannot dim and a user who typed their way onto the row.
    if (barredEntry(entry)) return { ...state, status: barredStatus(entry) }
    return assignTargetModel(
      state,
      entry.kind === "inherit" ? undefined : entry.model?.id,
      state.draftTargetOptions,
    )
  }
  const char = printable(key)
  if (char !== undefined) {
    return {
      ...state,
      filter: state.filter + char,
      cursor: { ...state.cursor, models: 0 },
      draftTargetOptions: [],
    }
  }
  return state
}

function reduceOptions(state: ConfigUIState, key: Key): ConfigUIState {
  const descriptors = targetDescriptors(state)
  if (descriptors.length === 0) return isEscape(key) ? { ...state, view: "models" } : state
  if (isUp(key)) return moveCursor(state, "options", -1, descriptors.length)
  if (isDown(key)) return moveCursor(state, "options", 1, descriptors.length)
  if (isEscape(key)) return { ...state, view: "models" }
  const descriptor = descriptors[state.cursor.options]
  if (descriptor === undefined) return state
  if (descriptor.type === "boolean" && (isEnter(key) || isSpace(key))) {
    const current = targetOptionValue(currentTarget(state), descriptor)
    return setCurrentTargetOption(state, descriptor.id, current === true ? undefined : true)
  }
  if (descriptor.type === "select" && (key.name === "left" || key.name === "right" || isEnter(key))) {
    return cycleTargetOption(state, descriptor, key.name === "left" ? -1 : 1)
  }
  return state
}

/**
 * The default-model picker: the employee picker's table, scoped to nobody.
 *
 * It reuses `cursor.models`, `draftVariant` and every helper behind them on
 * purpose — one model table in this UI, with one effort control and one
 * filter, whatever it is choosing for. The only difference is what enter
 * does: here it commits a `DefaultChoice` and moves to the apply view rather
 * than editing any seat.
 */
function reduceDefault(state: ConfigUIState, key: Key): ConfigUIState {
  if (state.targetId !== undefined) return reduceDefaultTargetModels(state, key)
  const entries = pickerEntries(state)

  if (isUp(key)) return clampVariant({ ...state, cursor: step(state.cursor, "models", -1, entries.length) }, entries)
  if (isDown(key)) return clampVariant({ ...state, cursor: step(state.cursor, "models", 1, entries.length) }, entries)
  if (key.name === "left") return cycleEffort(state, -1)
  if (key.name === "right") return cycleEffort(state, 1)
  if (key.name === "tab") return jumpGroup(state, entries, key.shift === true ? -1 : 1)
  if (key.name === "/") return { ...state, entry: { field: "filter", value: state.filter } }
  if (key.name === "m") return { ...state, entry: { field: "model", value: "" } }
  if (isEscape(key)) return { ...state, view: "menu" }

  if (isEnter(key)) {
    const entry = entries[state.cursor.models]
    if (!entry) return state
    // Inherit is not a default: an employee with no seat already inherits the
    // session's model, so offering that row here would dress a no-op up as a
    // choice.
    if (entry.kind === "inherit") {
      return {
        ...state,
        status:
          "Inherit cannot be the default: an employee with no seat already inherits the session's model. Pick a model.",
      }
    }
    if (barredEntry(entry)) return { ...state, status: barredStatus(entry) }
    return chooseDefault(state, entry.model?.id ?? "", state.draftVariant)
  }
  return state
}

function chooseDefault(state: ConfigUIState, model: string, variant: string | undefined): ConfigUIState {
  return {
    ...state,
    view: "apply",
    cursor: { ...state.cursor, apply: 0 },
    ...(variant === undefined ? { defaultChoice: { model } } : { defaultChoice: { model, variant } }),
    status: "",
  }
}

/**
 * The host/profile chooser the default flow opens on once targets exist.
 *
 * A default is written into one target, exactly as a per-employee pick is, so
 * the flow has to ask which one before it can show a model list at all: with
 * targets configured, `state.models` is empty until a catalogue is loaded for
 * a specific target. Asking here is what lets the picker below be the same
 * table, fed by the same catalogue, as the per-employee one.
 */
function reduceDefaultTarget(state: ConfigUIState, key: Key): ConfigUIState {
  const rows = targetRows(state)
  if (isUp(key)) return moveCursor(state, "default-target", -1, rows.length)
  if (isDown(key)) return moveCursor(state, "default-target", 1, rows.length)
  if (isEscape(key)) {
    const next = { ...state, view: "menu" as const }
    delete next.targetId
    return next
  }
  if (isEnter(key) || isSpace(key)) {
    const row = rows[state.cursor["default-target"]]
    if (row === undefined) return state
    return { ...openTargetPicker(state, row), view: "default" }
  }
  return state
}

/**
 * The default-model picker for one target: the per-employee target picker's
 * table, scoped to nobody.
 *
 * Every key does here what it does there — the same catalogue rows, the same
 * reasoning and context steppers, the same search — because the two are the
 * same act with a different recipient. Enter is the only difference: it arms a
 * `DefaultChoice` and moves to the apply view rather than editing one seat.
 */
function reduceDefaultTargetModels(state: ConfigUIState, key: Key): ConfigUIState {
  const entries = pickerEntries(state)
  if (isUp(key)) return moveTargetModelCursor(state, entries, -1)
  if (isDown(key)) return moveTargetModelCursor(state, entries, 1)
  if (key.name === "left") return cycleTargetPickerOption(state, "reasoning", -1)
  if (key.name === "right") return cycleTargetPickerOption(state, "reasoning", 1)
  if (key.name === "tab" && key.shift === true) return moveTargetGroup(state, entries)
  if (key.name === "tab") return cycleTargetPickerOption(state, "context", 1)
  if (key.name === "/") return { ...state, entry: { field: "filter", value: state.filter } }
  if (key.name === "backspace") {
    return {
      ...state,
      filter: state.filter.slice(0, -1),
      cursor: { ...state.cursor, models: 0 },
      draftTargetOptions: [],
    }
  }
  if (isEscape(key)) {
    const next: ConfigUIState = { ...state, view: "default-target", filter: "", draftTargetOptions: [] }
    delete next.targetId
    return next
  }
  if (isEnter(key)) {
    const entry = entries[state.cursor.models]
    if (entry === undefined) return state
    if (entries.length === 1 && state.filter.trim().length > 0) {
      return chooseTargetDefault(state, state.filter.trim())
    }
    // Inherit is not a default: an employee with no target for this host
    // already inherits the session's model, so offering that row here would
    // dress a no-op up as a choice.
    if (entry.kind === "inherit") {
      return {
        ...state,
        status:
          "Inherit cannot be the default: an employee with no target for this host already inherits the session's model. Pick a model.",
      }
    }
    if (barredEntry(entry)) return { ...state, status: barredStatus(entry) }
    const model = entry.model?.id
    return model === undefined ? state : chooseTargetDefault(state, model)
  }
  const char = printable(key)
  if (char !== undefined) {
    return {
      ...state,
      filter: state.filter + char,
      cursor: { ...state.cursor, models: 0 },
      draftTargetOptions: [],
    }
  }
  return state
}

/**
 * Arms a default for one target, options and all.
 *
 * The options are clamped against the catalogue the same way
 * `assignTargetModel` clamps them, so a default cannot carry an effort the
 * chosen model does not offer onto every employee at once.
 */
function chooseTargetDefault(state: ConfigUIState, model: string): ConfigUIState {
  const row = currentTargetRow(state)
  if (state.targetId === undefined || row === undefined) return state
  const catalogueModel = state.catalogues[state.targetId]?.models.find((candidate) => candidate.id === model)
  const options =
    catalogueModel === undefined
      ? state.draftTargetOptions
      : clampTargetOptions(state.draftTargetOptions, catalogueModel.options)
  return {
    ...state,
    view: "apply",
    cursor: { ...state.cursor, apply: 0 },
    defaultChoice: {
      model,
      targetId: state.targetId,
      host: row.host,
      ...(options.length === 0 ? {} : { options: options.map((option) => ({ ...option })) }),
    },
    status: "",
  }
}

/**
 * The pick, said the way the user made it.
 *
 * The legacy flow carries an effort in `variant`; a target's effort is one of
 * its options, named by whichever id that host uses. Reading it back through
 * the catalogue keeps the breadcrumb and the confirmation honest on both.
 */
export function describeDefaultChoice(state: ConfigUIState, choice: DefaultChoice): string {
  if (choice.targetId === undefined) {
    return `${choice.model}${choice.variant === undefined ? "" : ` at ${choice.variant} effort`}`
  }
  const descriptors = state.catalogues[choice.targetId]?.models.find((model) => model.id === choice.model)?.options ?? []
  const reasoning = descriptors.find((descriptor) => inlineTargetOption(descriptor) === "reasoning")
  const armed = choice.options?.find((option) => option.id === reasoning?.id)?.value
  if (typeof armed !== "string") return choice.model
  const label = reasoning?.choices?.find((entry) => entry.id === armed)?.label ?? armed
  return `${choice.model} at ${label} effort`
}

function reduceApply(state: ConfigUIState, key: Key): ConfigUIState {
  if (isUp(key)) return moveCursor(state, "apply", -1, DEFAULT_APPLY_ROWS.length)
  if (isDown(key)) return moveCursor(state, "apply", 1, DEFAULT_APPLY_ROWS.length)
  if (isEscape(key)) {
    // Back one level: to the picker the choice was made in when there was a
    // target to pick it for, and to the menu when there was not.
    const next: ConfigUIState = { ...state, view: state.targetId === undefined ? "menu" : "default" }
    delete next.defaultChoice
    return next
  }
  if (!isEnter(key) && !isSpace(key)) return state
  const scope = DEFAULT_APPLY_ROWS[state.cursor.apply]
  if (scope === undefined || state.defaultChoice === undefined) return state
  return applyDefault(state, scope)
}

/**
 * Writes the committed default onto every employee the scope names.
 *
 * Pure, like everything else in this file: it edits the working copy of
 * `seats` and marks it dirty; the ordinary save path writes the file and
 * regenerates agent definitions. Existing seats are edited, not replaced, so
 * an employee's skills — and any hand-written field Observer does not render —
 * survive even under the overwrite-everything scope.
 */
export function applyDefault(state: ConfigUIState, scope: DefaultApplyRowKind): ConfigUIState {
  const choice = state.defaultChoice
  if (choice === undefined) return state
  const description = describeDefaultChoice(state, choice)
  const ids = scope === "unseated" ? defaultUnseatedIds(state) : state.roster.map((row) => row.id)
  const target = choice.targetId === undefined ? "" : ` for ${choice.targetId}`

  if (ids.length === 0) {
    return {
      ...state,
      status:
        scope === "unseated"
          ? `Every employee already has a seat${target}, so there is nobody unseated to give ${description} to.`
          : "The roster is empty, so there is nobody to apply this to.",
    }
  }

  let next = state
  for (const id of ids) {
    next = updateSeat(next, id, (seat) =>
      choice.targetId === undefined
        ? seatWithOpencodeTarget(seat, choice.model, choice.variant)
        : seatWithDefaultTarget(seat, choice),
    )
  }
  const count = `${ids.length} employee${ids.length === 1 ? "" : "s"}`
  const applied: ConfigUIState = {
    ...next,
    view: "menu",
    status:
      scope === "unseated"
        ? `${description} set${target} for ${count} that had no seat. Press s to save.`
        : `${description} set${target} for all ${count}, replacing any model they had. Press s to save.`,
  }
  delete applied.targetId
  return applied
}

/**
 * One employee's target for the host the default was chosen for.
 *
 * The same shape `assignTargetModel` writes, so a seat cannot tell whether its
 * model arrived one employee at a time or as a default. Fields this UI does
 * not own are kept; the options are replaced rather than merged, because the
 * default is a complete statement about the model it names.
 */
function seatWithDefaultTarget(seat: SeatSpec, choice: DefaultChoice): SeatSpec {
  const targetId = choice.targetId
  if (targetId === undefined) return seat
  const targets = seatTargets(seat)
  const existing = targets[targetId]
  const host = choice.host ?? targetHostFromId(targetId)
  const target: SeatTarget =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing, host, model: choice.model }
      : { host, model: choice.model }
  const options = choice.options ?? []
  if (options.length === 0) delete target.options
  else target.options = options.map((option) => ({ ...option }))
  targets[targetId] = target
  return seatWithTargets(seat, targets)
}

/**
 * Who the "unseated only" scope means for the pick that is armed.
 *
 * With a target chosen, "unseated" is about that target: an employee with a
 * Copilot model and no OpenCode one has not been given an OpenCode default,
 * and skipping them because some other host is configured would quietly leave
 * them out of the very batch the scope exists to fill.
 */
export function defaultUnseatedIds(state: ConfigUIState): string[] {
  const targetId = state.defaultChoice?.targetId
  if (targetId === undefined) return unseatedIds(state)
  return state.roster
    .filter((row) => targetModel(seatTargets(state.seats.employees[row.id])[targetId]) === undefined)
    .map((row) => row.id)
}

/** Roster employees with no seat at all — the "unseated" scope. */
export function unseatedIds(state: ConfigUIState): string[] {
  return state.roster.filter((row) => state.seats.employees[row.id] === undefined).map((row) => row.id)
}

/**
 * Opens the default flow at whichever step the config has an answer for.
 *
 * With host targets configured there is no single model list to show, so the
 * flow starts by asking which target — the same question the per-employee flow
 * asks — and the catalogue for that target is what fills the picker.
 */
function openDefaultPicker(state: ConfigUIState): ConfigUIState {
  const next: ConfigUIState = { ...state, view: "default", filter: "", status: "", draftTargetOptions: [] }
  delete next.draftVariant
  delete next.targetId
  // The default belongs to nobody, so it must not read a model off whichever
  // employee happened to be open last.
  delete next.employeeId
  next.cursor = { ...state.cursor, models: 0, apply: 0 }
  if (state.profiles.length === 0) return next
  return { ...next, view: "default-target", cursor: { ...next.cursor, "default-target": 0 } }
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
      return {
        ...next,
        filter: entry.value,
        cursor: { ...next.cursor, models: 0 },
        ...(next.targetId === undefined ? {} : { draftTargetOptions: [] }),
      }
    }
    if (entry.field === "skills") return setSkills(next, entry.value)
    if (next.view === "default") {
      // A typed default takes the same apply step as a picked one. Empty is
      // not inherit here — inherit was refused one screen earlier — so an
      // empty field changes nothing.
      const typed = entry.value.trim()
      if (typed.length === 0) return state
      return next.targetId === undefined ? chooseDefault(next, typed, next.draftVariant) : chooseTargetDefault(next, typed)
    }
    const typed = entry.value.trim()
    if (next.targetId !== undefined) return assignTargetModel(next, typed.length === 0 ? undefined : typed)
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
  const target = opencodeTargetOf(seat)
  const model = readOpencodeTarget(target)?.model
  const next: ConfigUIState = { ...state, view: "models", filter: "" }
  const variant = readOpencodeTarget(target)?.variant
  if (variant !== undefined) next.draftVariant = variant
  else delete next.draftVariant
  // Land on the model the seat already names, so opening the picker to change
  // only the effort does not first make the user hunt for where they are.
  const entries = pickerEntries(next)
  const index = model === undefined ? 0 : entries.findIndex((entry) => entry.model?.id === model)
  next.cursor = { ...state.cursor, models: index >= 0 ? index : 0 }
  return clampVariant(next, entries)
}

function openTargetPicker(state: ConfigUIState, row: TargetRow): ConfigUIState {
  const catalogue = state.catalogues[row.id]
  const next: ConfigUIState = {
    ...state,
    view: "models",
    targetId: row.id,
    models: catalogue === undefined ? [] : catalogueModels(state, row.id, catalogue.models),
    draftTargetOptions: currentTargetOptions(state, row.id),
    filter: "",
  }
  delete next.draftVariant
  if (catalogue === undefined && row.capabilities !== undefined) next.request = "catalogue"
  return positionTargetPicker(next)
}

function positionTargetPicker(state: ConfigUIState): ConfigUIState {
  const model = targetModel(currentTarget(state))
  const entries = pickerEntries(state)
  const index = model === undefined ? 0 : entries.findIndex((entry) => entry.model?.id === model)
  return { ...state, cursor: { ...state.cursor, models: index >= 0 ? index : 0 } }
}

function currentTargetOptions(state: ConfigUIState, targetId: string): SeatTargetOption[] {
  const target = seatTargets(seatOf(state, state.employeeId))[targetId]
  return target && typeof target === "object" && !Array.isArray(target) && Array.isArray(target.options)
    ? target.options.map((option) => ({ ...option }))
    : []
}

function catalogueModels(
  state: ConfigUIState,
  targetId: string,
  models: CatalogueModel[],
): ModelInfo[] {
  const row = targetRows({ ...state, targetId }).find((entry) => entry.id === targetId)
  const provider = row?.host ?? targetHostFromId(targetId)
  const providerLabel = row?.hostLabel ?? provider
  return models.map((model) => ({
    id: model.id,
    provider,
    providerLabel,
    label: model.label,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.available === undefined ? {} : { available: model.available }),
    variants: { kind: "unknown" },
    known: true,
  }))
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
  const next =
    model === undefined ? updateSeat(state, id, clearOpencodeTarget) : updateSeat(state, id, (seat) => seatWithOpencodeTarget(seat, model, variant))
  return {
    ...next,
    view: "employee",
    status:
      model === undefined
        ? "Model cleared. This employee inherits the session's model, and the effort was dropped with it."
        : `Model set to ${model}${variant === undefined ? "" : ` at ${variant} effort`}.`,
  }
}

/**
 * Writes one employee's OpenCode target as `model` plus an optional effort.
 *
 * Shared by the per-employee picker and the default-model apply step so both
 * produce byte-identical targets. Existing target fields are kept — only the
 * two this UI owns are rewritten — and a variant of undefined removes the
 * option rather than storing an empty value.
 */
function seatWithOpencodeTarget(seat: SeatSpec, model: string, variant: string | undefined): SeatSpec {
  const targets = seatTargets(seat)
  const current = targets[LEGACY_TARGET_ID]
  const target: SeatTarget =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...current, host: "opencode", model }
      : { host: "opencode", model }
  target.options = setTargetOption(target.options, OPENCODE_VARIANT_OPTION, variant)
  if (target.options.length === 0) delete target.options
  targets[LEGACY_TARGET_ID] = target
  return seatWithTargets(seat, targets)
}

function clearOpencodeTarget(seat: SeatSpec): SeatSpec {
  const targets = seatTargets(seat)
  delete targets[LEGACY_TARGET_ID]
  return seatWithTargets(seat, targets)
}

function assignTargetModel(
  state: ConfigUIState,
  model: string | undefined,
  draftOptions: SeatTargetOption[] = state.draftTargetOptions,
): ConfigUIState {
  const id = state.employeeId
  const row = currentTargetRow(state)
  if (id === undefined || row === undefined) return state
  if (model === undefined && !row.configured) {
    return { ...state, view: "targets", status: `${row.hostLabel} is already unconfigured for this employee.` }
  }

  const catalogue = state.catalogues[row.id]
  const catalogueModel = catalogue?.models.find((candidate) => candidate.id === model)
  const descriptors = catalogueModel?.options ?? []
  const auxiliary = descriptors.filter((descriptor) => inlineTargetOption(descriptor) === undefined)
  const next = updateSeat(state, id, (seat) => {
    const targets = seatTargets(seat)
    if (model === undefined) {
      delete targets[row.id]
      return seatWithTargets(seat, targets)
    }
    const existing = targets[row.id]
    const target: SeatTarget =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? { ...existing, host: row.host, model }
        : { host: row.host, model }
    const sourceOptions = model === targetModel(existing) ? mergeTargetOptions(target.options, draftOptions) : draftOptions
    const options =
      catalogueModel === undefined
        ? sourceOptions
        : clampTargetOptions(sourceOptions, descriptors)
    if (options.length === 0) delete target.options
    else target.options = options
    targets[row.id] = target
    return seatWithTargets(seat, targets)
  })
  return {
    ...next,
    view: model !== undefined && auxiliary.length > 0 ? "options" : "targets",
    cursor: { ...next.cursor, options: 0 },
    status:
      model === undefined
        ? `${row.hostLabel} target removed.`
        : `${row.hostLabel} model set to ${model}.${auxiliary.length > 0 ? " Configure its other options below." : ""}`,
  }
}

function mergeTargetOptions(
  existing: SeatTargetOption[] | undefined,
  draft: SeatTargetOption[],
): SeatTargetOption[] {
  let merged = Array.isArray(existing) ? existing.map((option) => ({ ...option })) : []
  for (const option of draft) merged = setTargetOption(merged, option.id, option.value)
  return merged
}

function moveTargetModelCursor(
  state: ConfigUIState,
  entries: PickerEntry[],
  direction: number,
): ConfigUIState {
  const moved = moveCursor(state, "models", direction, entries.length)
  const entry = pickerEntries(moved)[moved.cursor.models]
  const configured = targetModel(currentTarget(moved))
  return {
    ...moved,
    // The status line is feedback about the row it was written on, so it goes
    // when the row does. A confirmation still sitting there under a different
    // model reads as a claim about that model.
    status: "",
    draftTargetOptions:
      entry?.kind === "model" && entry.model?.id === configured && moved.targetId !== undefined
        ? currentTargetOptions(moved, moved.targetId)
        : [],
  }
}

function moveTargetGroup(state: ConfigUIState, entries: PickerEntry[]): ConfigUIState {
  const moved = jumpGroup(state, entries, 1)
  const entry = pickerEntries(moved)[moved.cursor.models]
  const configured = targetModel(currentTarget(moved))
  return {
    ...moved,
    status: "",
    draftTargetOptions:
      entry?.kind === "model" && entry.model?.id === configured && moved.targetId !== undefined
        ? currentTargetOptions(moved, moved.targetId)
        : [],
  }
}

function cycleTargetPickerOption(
  state: ConfigUIState,
  kind: InlineTargetOption,
  direction: number,
): ConfigUIState {
  // Nothing to arm on a row that cannot be chosen. Cycling here would leave a
  // draft effort or tier attached to a model the user will never be allowed to
  // save, and the stepper moving at all would suggest the row is live.
  const entry = pickerEntries(state)[state.cursor.models]
  if (barredEntry(entry)) return { ...state, status: barredStatus(entry) }
  const descriptor = targetPickerDescriptor(state, kind)
  const choices = descriptor?.choices ?? []
  if (descriptor === undefined || choices.length === 0) {
    const label = kind === "context" ? "Context window" : "Reasoning effort"
    return { ...state, status: `${label} has no choices to cycle through for this model.` }
  }
  const defaultChoice =
    choices.find((choice) => choice.isDefault === true)?.id ??
    (typeof descriptor.currentValue === "string" ? descriptor.currentValue : undefined)
  const values: Array<string | undefined> =
    defaultChoice === undefined
      ? [undefined, ...choices.map((choice) => choice.id)]
      : choices.map((choice) => (choice.id === defaultChoice ? undefined : choice.id))
  const explicit = state.draftTargetOptions.find((option) => option.id === descriptor.id)?.value
  const current = typeof explicit === "string" ? explicit : undefined
  const at = values.indexOf(current)
  const chosen = values[wrap(at + direction, values.length)]
  return {
    ...state,
    draftTargetOptions: setTargetOption(state.draftTargetOptions, descriptor.id, chosen),
    status: cycledStatus(state, descriptor, chosen),
  }
}

/**
 * What the row now says, said out loud.
 *
 * The Context column shows one value rather than its whole scale, so `tab`
 * moving through that scale is a change the user could otherwise only detect
 * by watching one cell. The status line is where every other confirmation in
 * this UI lands, and it names the model as well as the value because the key
 * acts on the highlighted row and nothing else.
 */
function cycledStatus(
  state: ConfigUIState,
  descriptor: ModelOptionDescriptor,
  chosen: string | undefined,
): string {
  const entry = pickerEntries(state)[state.cursor.models]
  const model = entry?.model?.label ?? entry?.model?.id ?? "This model"
  if (chosen === undefined) return `${model}: ${descriptor.label.toLowerCase()} left at the host's default.`
  const label = descriptor.choices?.find((choice) => choice.id === chosen)?.label ?? chosen
  return `${model}: ${descriptor.label.toLowerCase()} set to ${label}.`
}

function removeTargetAtCursor(state: ConfigUIState, rows: TargetRow[]): ConfigUIState {
  const row = rows[state.cursor.targets]
  const id = state.employeeId
  if (row === undefined || id === undefined) return state
  if (!row.configured) return { ...state, status: `${row.hostLabel} is not configured for this employee.` }
  const next = updateSeat(state, id, (seat) => {
    const targets = seatTargets(seat)
    delete targets[row.id]
    return seatWithTargets(seat, targets)
  })
  return { ...next, status: `${row.hostLabel} target removed.` }
}

function setCurrentTargetOption(
  state: ConfigUIState,
  optionId: string,
  value: string | boolean | undefined,
): ConfigUIState {
  const employeeId = state.employeeId
  const targetId = state.targetId
  if (employeeId === undefined || targetId === undefined) return state
  return updateSeat(state, employeeId, (seat) => {
    const targets = seatTargets(seat)
    const current = targets[targetId]
    if (!current || typeof current !== "object" || Array.isArray(current)) return seat
    const target = { ...current }
    const options = setTargetOption(target.options, optionId, value)
    if (options.length === 0) delete target.options
    else target.options = options
    targets[targetId] = target
    return seatWithTargets(seat, targets)
  })
}

function cycleTargetOption(
  state: ConfigUIState,
  descriptor: ModelOptionDescriptor,
  direction: number,
): ConfigUIState {
  const values: Array<string | undefined> = [
    undefined,
    ...(descriptor.choices ?? []).map((choice) => choice.id),
  ]
  if (values.length <= 1) {
    return { ...state, status: `${descriptor.label} has no choices to cycle through.` }
  }
  const current = targetOptionValue(currentTarget(state), descriptor)
  const at = typeof current === "string" ? values.indexOf(current) : 0
  return setCurrentTargetOption(state, descriptor.id, values[wrap(at + direction, values.length)])
}

function clampTargetOptions(
  options: SeatTargetOption[] | undefined,
  descriptors: ModelOptionDescriptor[],
): SeatTargetOption[] {
  if (!Array.isArray(options)) return []
  return options.filter((option) => {
    const descriptor = descriptors.find((candidate) => candidate.id === option.id)
    if (descriptor === undefined) return false
    if (descriptor.type === "boolean") return typeof option.value === "boolean"
    if (typeof option.value !== "string") return false
    const choices = descriptor.choices ?? []
    return choices.length === 0 || choices.some((choice) => choice.id === option.value)
  })
}

function seatWithTargets(seat: SeatSpec, targets: Record<string, SeatTarget>): SeatSpec {
  const { model: _model, variant: _variant, targets: _targets, ...rest } = seat
  return Object.keys(targets).length === 0 ? rest : { ...rest, targets }
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
  return readOpencodeTarget(opencodeTargetOf(seat))?.model ?? ""
}

function currentTarget(state: ConfigUIState): SeatTarget | undefined {
  if (state.targetId === undefined) return undefined
  return seatTargets(seatOf(state, state.employeeId))[state.targetId]
}

function targetModel(target: SeatTarget | undefined): string | undefined {
  return target && typeof target === "object" && !Array.isArray(target) && typeof target.model === "string"
    ? target.model
    : undefined
}

function targetHostFromId(targetId: string): string {
  const separator = targetId.indexOf(":")
  return separator === -1 ? targetId : targetId.slice(0, separator)
}

function profileLabelFromId(targetId: string): string {
  const separator = targetId.indexOf(":")
  return separator === -1 ? "default" : targetId.slice(separator + 1)
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
  for (const [id, spec] of Object.entries(seats.employees ?? {})) {
    const copy: SeatSpec = { ...spec }
    if (spec.targets !== undefined) copy.targets = structuredClone(spec.targets)
    employees[id] = copy
  }
  return { control: seats.control === true, employees }
}

function opencodeTargetOf(seat: SeatSpec | undefined): SeatTarget | undefined {
  return seatTargets(seat)[LEGACY_TARGET_ID]
}

function setTargetOption(
  options: SeatTargetOption[] | undefined,
  id: string,
  value: string | boolean | undefined,
): SeatTargetOption[] {
  const existing = Array.isArray(options) ? options : []
  if (value === undefined || value === "") return existing.filter((option) => option.id !== id)
  if (existing.some((option) => option.id === id)) {
    return existing.map((option) => (option.id === id ? { ...option, value } : option))
  }
  return [...existing, { id, value }]
}

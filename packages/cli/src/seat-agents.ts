import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  OPENCODE_DEFAULT_PROFILE,
  applySeatSkills,
  createOpencodeAdapter,
  diagnoseOpencodeModel,
  diagnoseSeats,
  readOpencodeTarget,
  seatFor,
  seatTargets,
} from "@observer-ai/daemon"
import type { OpencodeSeatTarget, SeatIssue, SeatSpec, SeatTarget, SeatsConfig } from "@observer-ai/daemon"
import { behaviorDirective, getEmployee, ROSTER } from "@observer-ai/roster"
import { opencodeAgentDir } from "./paths.js"

/**
 * Generated OpenCode employee definitions. The full roster is always
 * selectable; seat control only adds a model and variant to the chosen
 * employee's definition.
 *
 * Two properties matter more than any feature:
 *
 *  1. Turning `control` off must remove model pins without removing employees.
 *     A stale model field keeps billing the user for a choice they disabled,
 *     so every run reconciles the whole directory rather than applying a delta.
 *  2. Nothing Observer did not write is ever deleted. The directory is the
 *     user's; a hand-written `observer-notes.md` has to survive both a sync and
 *     an uninstall. Ownership is proved by a marker inside the file, not by the
 *     name, because a name is a guess and a marker is evidence.
 *
 * What a seat *asks for* is not decided here. Seats reach this module through
 * `seatTargets`, which is the one place a legacy `model`/`variant` pair becomes
 * an `opencode:default` target, and the OpenCode adapter is what decodes that
 * target and rules on whether it can work. This module keeps exactly one
 * judgement: which files exist.
 */

/**
 * Proof that Observer wrote a file, and the only thing that authorises
 * deleting it.
 *
 * It is a YAML comment on purpose: OpenCode parses the frontmatter with a YAML
 * parser and drops comments, so this is invisible to the host and legible to
 * us. Deleting the line is how a user adopts a generated file as their own.
 */
const MARKER = "observer:employee-agent v1"
const LEGACY_MARKER = "observer:seat-agent v1"

/** Only files matching this *and* carrying the marker are ever removed. */
const GENERATED_FILE = /^observer-.+\.md$/

/**
 * The OpenCode agent name for an employee's generated definition. Slug-shaped.
 *
 * The shape is load-bearing twice over. OpenCode names a child session
 * `description + " (@" + agentName + " subagent)"`, and the plugin strips that
 * decoration with `/\s*\(\s*@?[\w.\-]+\s+subagent\s*\)\s*$/i` to join the child
 * back to its delegation. A name with a space in it would fail that regex and
 * silently cost every seated node its employee. The character class here is a
 * strict subset of `[\w.\-]`, so the join cannot break. It is also a safe
 * filename, which is the other thing it has to be — `.` is excluded even though
 * the regex would accept it, so no generated name can ever contain `..`.
 *
 * **This rule is duplicated in `integrations/opencode/observer-plugin.js`**,
 * which is dependency-free plain JavaScript copied verbatim into the user's
 * config directory and so cannot import it. Change one, change both.
 */
export function seatAgentName(employeeId: string): string {
  const slug = String(employeeId)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `observer-${slug.length > 0 ? slug : "unknown"}`
}

/** Directory the generated definitions live in. */
export function seatAgentDir(): string {
  return opencodeAgentDir()
}

export interface SeatAgentSync {
  /** Absolute paths written this run. */
  written: string[]
  /** Absolute paths removed because their seat no longer asks for a model. */
  removed: string[]
  /** Human-readable lines for the CLI to print. */
  notes: string[]
}

/**
 * Brings ~/.config/opencode/agent/observer-*.md into line with the roster and
 * its optional model pins. Every roster employee gets a selectable agent.
 * Seat control only decides whether that definition pins a model.
 *
 * `written` and `removed` are literal: a run that finds every file already
 * correct reports both as empty. That makes idempotency observable instead of
 * merely claimed, so `notes` — not `written.length` — is what a caller should
 * print to say how many definitions are in force.
 *
 * Throws nothing the caller has to catch beyond ordinary filesystem errors: a
 * seat that cannot work is skipped and explained in `notes` rather than
 * written out and left to fail inside the host.
 */
export function syncSeatAgents(seats: SeatsConfig): SeatAgentSync {
  const directory = seatAgentDir()
  const notes: string[] = []
  const normalized = normalizeSeats(seats)
  const control = normalized.control === true
  const desired = renderDesired(normalized, notes, control)

  const written: string[] = []
  const removed: string[] = []

  if (desired.size > 0) mkdirSync(directory, { recursive: true })

  for (const [file, contents] of desired) {
    const path = join(directory, file)
    // Skip a byte-identical rewrite: an unchanged mtime is the cheapest signal
    // to anything watching this directory that nothing actually happened.
    const before = readIfPresent(path)
    if (before === contents) continue
    if (before !== undefined && !isOwned(before)) {
      notes.push(`${path} was left unchanged because Observer does not own it.`)
      continue
    }
    writeFileSync(path, contents)
    written.push(path)
  }

  for (const path of generatedFiles(directory)) {
    if (desired.has(basenameOf(path))) continue
    rmSync(path, { force: true })
    removed.push(path)
  }

  notes.unshift(...summarise({ control, directory, desired: desired.size, written, removed }))
  return { written, removed, notes }
}

function normalizeSeats(seats: SeatsConfig): SeatsConfig {
  if (typeof seats !== "object" || seats === null || Array.isArray(seats)) return { control: false, employees: {} }
  const employees = typeof seats.employees === "object" && seats.employees !== null && !Array.isArray(seats.employees)
    ? seats.employees
    : {}
  return { ...seats, employees }
}

/** Absolute paths of every file in the directory that Observer generated. */
function generatedFiles(directory: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    // No directory means nothing was ever generated, which is a clean state.
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    // `observer.md` is the @observer mention, not a seat, and does not match.
    if (!GENERATED_FILE.test(entry)) continue
    const path = join(directory, entry)
    if (!isOwned(readIfPresent(path))) continue
    found.push(path)
  }
  return found
}

/**
 * Removes every generated seat definition, whatever the config says.
 *
 * Used by `uninstall("opencode")`: pulling Observer out has to leave the agent
 * directory as it was found, and a definition naming a model the user never
 * chose is exactly the kind of litter an uninstall exists to clear.
 */
export function removeSeatAgents(): string[] {
  const removed: string[] = []
  for (const path of generatedFiles(seatAgentDir())) {
    rmSync(path, { force: true })
    removed.push(path)
  }
  return removed
}

// ------------------------------------------------------------------ rendering

/** filename -> file contents, for every employee, with a model pin when active. */
function renderDesired(seats: SeatsConfig, notes: string[], control: boolean): Map<string, string> {
  const desired = new Map<string, string>()

  // Every seat reduced to the one OpenCode target it asks for, whether it was
  // written as `targets` or as the legacy `model`/`variant` pair.
  const seated = opencodeSeats(seats, notes)

  /**
   * One adapter for this run, primed with the models the config names.
   *
   * Per-run rather than the registry's singleton because the adapter memoises
   * the 4 MB catalogue for its own lifetime: a process-long instance would
   * answer a later sync from a snapshot taken before the user changed
   * anything. The memo is still lazy, so a config that pairs no model with a
   * variant never reads the file at all.
   */
  const adapter = createOpencodeAdapter({
    include: seated.flatMap((seat) => (seat.resolved ? [seat.resolved.model] : [])),
  })

  // Host-agnostic findings plus OpenCode's own. This module writes OpenCode
  // agent definitions and nothing else, so it is entitled to the second list
  // and obliged to act on it: the adapter owns both the `provider/model` slash
  // rule and the variant-versus-model check, and either one can mean no file.
  const issues = [
    ...diagnoseSeats(seats).issues,
    ...seated.flatMap((seat) => adapter.diagnose(OPENCODE_DEFAULT_PROFILE, seat.targetId, seat.target, seat.employeeId)),
  ]

  /**
   * A seat with an `error` finding cannot work as written, so no file is
   * generated for it. That matters more than it sounds: a definition whose
   * model is missing its provider still loads, still appears in the host's
   * agent list, and so still passes the plugin's existence check — and then
   * fails the delegation when the model is resolved. Not writing the file is
   * what turns that into a no-op instead of a broken task.
   *
   * Blocking on severity rather than on a code keeps the rules where they are
   * owned: `diagnoseSeats` decides what is wrong for every host, the OpenCode
   * adapter decides what is wrong for this one, and this module only decides
   * which files exist.
   */
  const blocked = new Set(
    issues.filter((issue) => issue.severity === "error" && issue.employeeId).map((issue) => issue.employeeId as string),
  )

  const active = new Map(
    seated
      .filter((seat) => control && !blocked.has(seat.employeeId) && seat.resolved !== undefined)
      .map((seat) => [seat.employeeId, seat.resolved!]),
  )
  for (const profile of ROSTER) {
    desired.set(`${seatAgentName(profile.id)}.md`, renderAgent(profile.id, seats, active.get(profile.id)))
  }

  for (const issue of issues) {
    // Report only what bears on which files exist, in the diagnosis' own
    // words. Re-wording it here would give the CLI and the TUI two vocabularies
    // for one finding.
    if (isReported(issue)) notes.push(issue.message)
  }

  return desired
}

/**
 * Whether a finding explains an absent or refused agent definition.
 *
 * Two rules rather than a code list, because the codes are open and the
 * question is not:
 *
 *  - every `error` scoped to an employee blocked that employee's file, so the
 *    user is owed the reason — that covers `unknown-employee`,
 *    `malformed-model`, `unknown-host` and the adapter's undeclared-variant
 *    refusal without this module having to keep a copy of the list;
 *  - the two "you set an option but no model" warnings explain a file that was
 *    never going to exist. They are warnings precisely because nothing is
 *    broken, but silence would leave the seat invisible.
 *
 * Everything else — `empty-seat`, `empty-target`, `unknown-field`,
 * `legacy-fields-shadowed`, `control-disabled` — is about the config rather
 * than about the directory, and the TUI already renders it.
 */
function isReported(issue: SeatIssue): boolean {
  if (issue.severity === "error" && issue.employeeId !== undefined) return true
  return issue.code === "variant-without-model" || issue.code === "options-without-model"
}

/**
 * One seat, reduced to the OpenCode target it asks for.
 *
 * `target` is kept alongside `resolved` because the adapter diagnoses the raw
 * target — it is the thing the user wrote and the thing paths point at — while
 * only the decoded form can be rendered into frontmatter.
 */
interface OpencodeSeat {
  employeeId: string
  /** The key the target is filed under, e.g. `opencode:default`. */
  targetId: string
  target: SeatTarget
  /** Undefined when the target names no model. */
  resolved: OpencodeSeatTarget | undefined
}

/**
 * Every seat that asks OpenCode for something, resolved through `seatTargets`.
 *
 * `seatTargets` is the point of this function. It is the one place the legacy
 * `model`/`variant` pair becomes a target, so a seat written either way
 * arrives here in a single shape and this module never has to decide for
 * itself whether a config is old or new. Reading `spec.model` directly — which
 * is what this module used to do — meant a seat configured with `targets`
 * generated no file at all and seat control silently did nothing for it, while
 * a half-migrated seat could be honoured on a model its `targets` had already
 * replaced. Both failures are silent, and both show up as the wrong model on a
 * bill.
 *
 * A legacy seat is therefore byte-identical by construction rather than by
 * coincidence: `seatTargets` derives `{ host: "opencode", model, options:
 * [{ id: "variant", value }] }` from it, `readOpencodeTarget` decodes exactly
 * those two fields back out, and `renderAgent` sees the pair it always saw.
 *
 * `seatFor` returns undefined for an id that is not on the roster, so a typo
 * can never become a file. The `unknown-employee` finding still reports it.
 */
function opencodeSeats(seats: SeatsConfig, notes: string[]): OpencodeSeat[] {
  const found: OpencodeSeat[] = []
  for (const id of Object.keys(seats?.employees ?? {})) {
    const spec = seatFor(seats, id)
    if (!spec) continue
    const targets = Object.entries(seatTargets(spec)).filter(([, target]) => target?.host === "opencode")
    const first = targets[0]
    if (!first) continue

    // A generated agent definition is named per employee, so two OpenCode
    // profiles on one seat cannot both have one. Said out loud rather than
    // resolved by silently picking a winner: a user who configures a second
    // profile and watches it do nothing has no way to find out why.
    if (targets.length > 1) {
      notes.push(
        `${id} has ${targets.length} OpenCode targets (${targets.map(([key]) => `"${key}"`).join(", ")}), and a generated agent definition is named per employee, so only "${first[0]}" was applied.`,
      )
    }

    found.push({ employeeId: id, targetId: first[0], target: first[1], resolved: readOpencodeTarget(first[1]) })
  }
  return found
}

/**
 * The OpenCode-specific findings for a whole seats config, catalogue excluded.
 *
 * `diagnoseSeats` deliberately no longer applies OpenCode's `provider/model`
 * rule, because it is host policy and not a fact about models: Codex's
 * `gpt-5.6-sol` and Grok's `grok-build` are correct as written and were being
 * failed by it. The rule still has to be applied *somewhere* for OpenCode, or
 * a slashless model silently becomes an agent definition that loads, passes
 * the plugin's existence check and only then fails the delegation.
 *
 * This is the render-path half of that, and it stays deliberately narrower
 * than `createOpencodeAdapter(...).diagnose`. The adapter also rules on
 * whether a model declares the variant a target asks for, and answering that
 * costs a 4 MB catalogue parse. `render` in the config TUI calls this on every
 * keystroke, so it gets the rule that is pure arithmetic and `syncSeatAgents`
 * — which runs once, on a save — gets both. Same sentence either way: both
 * paths lead to `diagnoseOpencodeModel`, which owns the wording.
 *
 * Target precedence matches `seatTargets`: explicit `targets` win outright, so
 * a migrated seat is never diagnosed twice. Legacy `model` is reported on the
 * field itself, at the path the user can actually find in their file, rather
 * than at the `targets.opencode:default.…` path the derived target would give
 * it.
 */
export function diagnoseOpencodeSeats(seats: SeatsConfig): SeatIssue[] {
  const issues: SeatIssue[] = []
  for (const [id, entry] of Object.entries(seats?.employees ?? {})) {
    const spec: SeatSpec = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {}
    const path = `seats.employees.${id}`
    const explicit = spec.targets && typeof spec.targets === "object" && !Array.isArray(spec.targets) ? spec.targets : undefined

    if (explicit === undefined) {
      if (typeof spec.model !== "string" || spec.model.length === 0) continue
      const issue = diagnoseOpencodeModel(spec.model, {
        path: `${path}.model`,
        employeeId: id,
        targetId: "opencode:default",
      })
      if (issue) issues.push(issue)
      continue
    }

    for (const [targetId, raw] of Object.entries(explicit)) {
      const target = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as SeatTarget) : undefined
      if (target?.host !== "opencode") continue
      if (typeof target.model !== "string" || target.model.length === 0) continue
      const issue = diagnoseOpencodeModel(target.model, { path: `${path}.targets.${targetId}.model`, employeeId: id, targetId })
      if (issue) issues.push(issue)
    }
  }
  return issues
}

/**
 * One agent definition.
 *
 * The body is deliberately empty. OpenCode sets `prompt` to the trimmed file
 * body and then uses it only when truthy — `agent.prompt ? [agent.prompt] :
 * providerDefault(model)` — so an empty body leaves the generated agent with
 * exactly the prompt the built-in `general` subagent gets, which itself ships
 * with no prompt at all. The persona directive stays in the plugin, which
 * appends it to the task prompt at seating time; see the note in
 * `observer-plugin.js` for why it cannot live in both places.
 *
 * The target keeps `general`'s prompt and work permissions, then adds only the
 * task and Observer coordination tools needed for nested delegation and direct
 * messaging. It does not widen file, shell or network access.
 *
 * Takes the decoded target rather than the seat spec, so the file's contents
 * cannot depend on how the seat was written. `readOpencodeTarget` is the only
 * thing that turns `targets` or a legacy `model`/`variant` pair into these two
 * fields, which is what makes a migrated seat byte-identical to the one it
 * replaced instead of merely similar.
 */
function renderAgent(employeeId: string, seats: SeatsConfig, target: OpencodeSeatTarget | undefined): string {
  const profile = getEmployee(employeeId)
  if (!profile) throw new Error(`Unknown employee ${employeeId}`)
  const who = `${profile.fullName} (${profile.title})`
  const lines = [
    "---",
    `# ${MARKER} - generated by Observer for roster employee ${employeeId}.`,
    "# Edits are overwritten by `observer install opencode`. Delete the line above to keep this file.",
    `name: ${yaml(seatAgentName(employeeId))}`,
    `description: ${yaml(`Use ${who} for delegated work matching ${profile.fields.slice(0, 5).join(", ")}.`)}`,
    "mode: subagent",
    // The one permission the built-in `general` subagent denies and a bare
    // generated agent does not. Keep this in step with whatever `general`
    // denies; a live `GET /agent` diff against `general` is how to check.
    "permission:",
    `  todowrite: ${yaml("deny")}`,
  ]
  if (target !== undefined) lines.push(`model: ${yaml(target.model)}`)
  if (target?.variant !== undefined) {
    // Free-form on purpose: each model declares its own subset of efforts and
    // the host has the final say, so an enum here would reject a level that
    // ships in models.dev tomorrow.
    lines.push(`variant: ${yaml(target.variant)}`)
  }
  lines.push("---", "", behaviorDirective(applySeatSkills(profile, seats)), "")
  return lines.join("\n")
}

/**
 * Quotes a value as a YAML scalar.
 *
 * JSON strings are valid YAML 1.2 double-quoted scalars, and these values come
 * from a hand-edited config file, so a model id containing a colon or a quote
 * has to survive rather than corrupt the frontmatter.
 */
function yaml(value: string): string {
  return JSON.stringify(value)
}

// -------------------------------------------------------------------- notes

function summarise(input: {
  control: boolean
  directory: string
  desired: number
  written: string[]
  removed: string[]
}): string[] {
  const notes: string[] = []
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`

  notes.push(`${count(input.desired, "employee agent definition")} available in ${input.directory}.`)
  if (input.removed.length > 0) {
    notes.push(`Removed ${count(input.removed.length, "generated agent definition")} whose seat no longer asks for one.`)
  }
  if (input.written.length > 0) {
    notes.push("Restart OpenCode so the new agent definitions load; agents are read at startup.")
  }
  notes.push(
    input.control
      ? `Seat control pins configured models on employee agents. It does not force OpenCode to use an employee; OpenCode may choose one when its description fits.`
      : "Seat control is off, so every employee agent inherits OpenCode's model choice.",
  )
  return notes
}

function isOwned(contents: string | undefined): boolean {
  return contents?.includes(MARKER) === true || contents?.includes(LEGACY_MARKER) === true
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] as string
}

/** Whether anything has been generated, without reading the config. */
export function hasSeatAgents(): boolean {
  const directory = seatAgentDir()
  return existsSync(directory) && generatedFiles(directory).length > 0
}

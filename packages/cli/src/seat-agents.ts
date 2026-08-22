import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { diagnoseSeats, seatFor } from "@observer-ai/daemon"
import type { SeatSpec, SeatsConfig } from "@observer-ai/daemon"
import { getEmployee } from "@observer-ai/roster"
import { type ModelInfo, listModels, variantsFor } from "./models.js"
import { opencodeAgentDir } from "./paths.js"

/**
 * Generated OpenCode agent definitions: the half of seat control that makes a
 * seat spec's model and reasoning effort real.
 *
 * OpenCode's task tool takes no model parameter. The only lever is
 * `subagent_type` -> agent definition -> `model`, so applying a seat spec means
 * writing a per-employee agent file here and having the plugin point the
 * delegation at it. Everything in this module is therefore about one question:
 * is the file on disk exactly what the config asks for, and nothing more?
 *
 * Two properties matter more than any feature:
 *
 *  1. Turning `control` off must actually turn it off. A stale definition left
 *     behind after a disabled save keeps billing the user for a model they
 *     stopped asking for, so every run reconciles the whole directory rather
 *     than applying a delta.
 *  2. Nothing Observer did not write is ever deleted. The directory is the
 *     user's; a hand-written `observer-notes.md` has to survive both a sync and
 *     an uninstall. Ownership is proved by a marker inside the file, not by the
 *     name, because a name is a guess and a marker is evidence.
 */

/**
 * Proof that Observer wrote a file, and the only thing that authorises
 * deleting it.
 *
 * It is a YAML comment on purpose: OpenCode parses the frontmatter with a YAML
 * parser and drops comments, so this is invisible to the host and legible to
 * us. Deleting the line is how a user adopts a generated file as their own.
 */
const MARKER = "observer:seat-agent v1"

/** Only files matching this *and* carrying the marker are ever removed. */
const GENERATED_FILE = /^observer-.+\.md$/

/**
 * The `subagent_type` values seat control is allowed to replace.
 *
 * `subagent_type` does not select a model — it selects a whole agent
 * definition, prompt and tool permissions included. `general` is the only
 * built-in that ships with neither, so substituting a generated seat agent for
 * it is lossless: it changes the model and nothing else. Every other agent,
 * built-in or user-written, carries intent Observer did not author, and
 * `explore` — a specialised prompt plus a deny-by-default permission set that
 * allows only reads and searches — is why this is a
 * rule and not a preference. Dropping a read-only restriction to honour a model
 * preference is not a trade Observer makes silently.
 *
 * Nothing in this module branches on the list; the plugin is what enforces it.
 * It lives here so `summarise` can tell the user what seat control applies to
 * without a second copy of the sentence, and so a test can pin the two lists
 * together.
 *
 * **This rule is duplicated in `integrations/opencode/observer-plugin.js`**,
 * which is dependency-free plain JavaScript copied verbatim into the user's
 * config directory and so cannot import it. Change one, change both.
 */
export const NEUTRAL_AGENT_TYPES = ["general"] as const

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
 * Brings ~/.config/opencode/agent/observer-*.md into line with the seat specs.
 * Safe to call repeatedly. Writes nothing when seats.control is false, and
 * removes any definitions a previous run left behind.
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
  const control = seats?.control === true
  const desired = control ? renderDesired(seats, notes) : new Map<string, string>()

  const written: string[] = []
  const removed: string[] = []

  if (desired.size > 0) mkdirSync(directory, { recursive: true })

  for (const [file, contents] of desired) {
    const path = join(directory, file)
    // Skip a byte-identical rewrite: an unchanged mtime is the cheapest signal
    // to anything watching this directory that nothing actually happened.
    if (readIfPresent(path) === contents) continue
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
    if (!readIfPresent(path)?.includes(MARKER)) continue
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

/** filename -> file contents, for every seat that can actually work. */
function renderDesired(seats: SeatsConfig, notes: string[]): Map<string, string> {
  const desired = new Map<string, string>()
  const diagnosis = diagnoseSeats(seats)

  /**
   * A seat with an `error` finding cannot work as written, so no file is
   * generated for it. That matters more than it sounds: a definition whose
   * model is missing its provider still loads, still appears in the host's
   * agent list, and so still passes the plugin's existence check — and then
   * fails the delegation when the model is resolved. Not writing the file is
   * what turns that into a no-op instead of a broken task.
   *
   * The rule is `diagnoseSeats`' to own, not this module's; blocking on
   * severity keeps it that way.
   */
  const blocked = new Set(
    diagnosis.issues
      .filter((issue) => issue.severity === "error" && issue.employeeId)
      .map((issue) => issue.employeeId as string),
  )

  const declaredVariants = variantOracle(seats)

  for (const id of Object.keys(seats?.employees ?? {})) {
    if (blocked.has(id)) continue
    // `seatFor` returns undefined for an id that is not on the roster, so a
    // typo can never become a file.
    const spec = seatFor(seats, id)
    if (!spec || typeof spec.model !== "string" || spec.model.length === 0) continue
    const rejected = declaredVariants(spec)
    if (rejected) {
      notes.push(rejected)
      continue
    }
    desired.set(`${seatAgentName(id)}.md`, renderAgent(id, spec))
  }

  for (const issue of diagnosis.issues) {
    // Report only what bears on which files exist, in `diagnoseSeats`' own
    // words. Re-wording it here would give the CLI and the TUI two vocabularies
    // for one finding.
    if (issue.code === "unknown-employee" || issue.code === "malformed-model" || issue.code === "variant-without-model") {
      notes.push(issue.message)
    }
  }

  return desired
}

// ------------------------------------------------------------- variant check

/**
 * Refuses to generate a definition whose `variant` its `model` does not
 * declare. Returns the sentence explaining the refusal, or undefined to write.
 *
 * This closes the gap the existence check cannot. OpenCode validates a variant
 * per model at *use* time — `if (x.variant && !R.variants?.[x.variant])
 * fail(...)` — not at load time, so a seat with a variant the model does not
 * offer writes a valid file, loads, appears in `GET /agent`, passes the
 * plugin's existence check, and only then fails the delegation. That is the
 * precise outcome the existence check exists to prevent, so the same remedy
 * applies: do not write the file, and say why.
 *
 * It lives here rather than in `diagnoseSeats` because it needs the host's
 * model catalogue, which is a CLI-side cache under `~/.cache/opencode`. The
 * daemon has no business reading it and must stay answerable without one.
 * Placing it here keeps the ownership clean instead of adding a third
 * vocabulary: `diagnoseSeats` still owns whether a seat is *configured*
 * wrongly, `variantsFor` still owns what a model *declares*, and this module
 * only decides whether a file gets written — which is the one judgement it has
 * always made.
 *
 * The catalogue is read once per sync and only when some seat actually pairs a
 * model with a variant, so the common case pays nothing for it.
 */
function variantOracle(seats: SeatsConfig): (spec: SeatSpec) => string | undefined {
  const checkable = Object.values(seats?.employees ?? {}).filter(
    (spec) => typeof spec?.model === "string" && spec.model.length > 0 && typeof spec?.variant === "string" && spec.variant.length > 0,
  )
  if (checkable.length === 0) return () => undefined

  // `include` pins the configured models into the list regardless of which
  // providers the user holds credentials for. Without it a lapsed key would
  // make a perfectly good model look unknown, and the check would go quiet
  // exactly when it still had something true to say.
  const catalogue: ModelInfo[] = listModels({ include: checkable.map((spec) => spec.model as string) })

  return (spec) => {
    const variant = spec.variant
    if (typeof variant !== "string" || variant.length === 0) return undefined
    const declared = variantsFor(catalogue, spec.model as string)
    // `known: false` means the catalogue is absent, corrupt, or has never heard
    // of this model, and `values` is then a guess across every provider. An
    // unknown model is not a wrong model: write the file and let the host rule.
    if (!declared.known) return undefined
    /**
     * An empty list is a verdict, not silence. `variantsFor` distinguishes
     * "this model takes no reasoning effort" from "we cannot work out which
     * efforts it takes" — the mechanisms OpenCode synthesises variants for,
     * like `budget_tokens`, come back as unknown and are already let through
     * above. So reaching here with an empty list means the host will reject
     * every variant for this model, which is exactly what to refuse.
     */
    if (declared.values.length === 0) {
      return `${spec.model} takes no reasoning effort, so "${variant}" cannot apply and no agent definition was written for it. OpenCode fails a delegation whose variant its model does not declare rather than ignoring the variant, so the seat is skipped instead.`
    }
    if (declared.values.includes(variant)) return undefined
    return `Reasoning effort "${variant}" is not one ${spec.model} offers (${declared.values.join(", ")}), so no agent definition was written for it. OpenCode fails a delegation whose variant its model does not declare rather than ignoring the variant, so the seat is skipped instead.`
  }
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
 * The target is a definition indistinguishable from `general` except for the
 * model, because `general` is the only `subagent_type` the plugin will replace
 * and the swap is only defensible if it is lossless. Verified against a live
 * `opencode serve`: with the `permission` block below, `GET /agent` reports the
 * same permission set for a generated seat as it does for `general`.
 */
function renderAgent(employeeId: string, spec: SeatSpec): string {
  const profile = getEmployee(employeeId)
  const who = profile ? `${profile.fullName} (${profile.title})` : employeeId
  const lines = [
    "---",
    `# ${MARKER} - generated by Observer from seats.employees.${employeeId}.`,
    "# Edits are overwritten by `observer install opencode`. Delete the line above to keep this file.",
    `name: ${yaml(seatAgentName(employeeId))}`,
    `description: ${yaml(`Observer seat for ${who}. Runs delegated work on the model this employee is assigned.`)}`,
    "mode: subagent",
    // Hidden keeps fourteen generated entries out of OpenCode's @ menu. The
    // plugin reaches them by name; a human never needs to.
    "hidden: true",
    // The one permission the built-in `general` subagent denies and a bare
    // generated agent does not. Without this line the swap quietly *widens*
    // what a delegated subagent may do — the host lets it edit the parent
    // session's todo list — which is the same class of silent change the
    // NEUTRAL_AGENT_TYPES allow-list exists to prevent, just smaller. Keep it
    // in step with whatever `general` denies; a live `GET /agent` diff against
    // `general` is how to check.
    "permission:",
    `  todowrite: ${yaml("deny")}`,
    `model: ${yaml(spec.model as string)}`,
  ]
  if (typeof spec.variant === "string" && spec.variant.length > 0) {
    // Free-form on purpose: each model declares its own subset of efforts and
    // the host has the final say, so an enum here would reject a level that
    // ships in models.dev tomorrow.
    lines.push(`variant: ${yaml(spec.variant)}`)
  }
  lines.push("---", "")
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

  if (!input.control) {
    if (input.removed.length > 0) {
      notes.push(
        `Seat control is off, so ${count(input.removed.length, "generated agent definition")} were removed from ${input.directory}.`,
      )
    }
    return notes
  }

  if (input.desired === 0) {
    if (input.removed.length > 0) {
      notes.push(`Removed ${count(input.removed.length, "generated agent definition")} whose seat no longer asks for one.`)
    }
    return notes
  }

  notes.push(`${count(input.desired, "seat agent definition")} in force in ${input.directory}.`)
  if (input.removed.length > 0) {
    notes.push(`Removed ${count(input.removed.length, "generated agent definition")} whose seat no longer asks for one.`)
  }
  if (input.written.length > 0) {
    notes.push("Restart OpenCode so the new agent definitions load; agents are read at startup.")
  }
  // The two visible behaviour changes, said where somebody will read it. The
  // task tool asks permission with the agent name it was given, so a seated
  // delegation now prompts for `observer-<employee>` and not for `general` —
  // and only a `general` delegation is touched at all, because every other
  // agent carries a prompt or a tool restriction seat control must not discard.
  notes.push(
    `Seat control applies to ${NEUTRAL_AGENT_TYPES.map((name) => `\`${name}\``).join(" or ")} delegations only: those now ask permission as \`observer-<employee>\` and run on that employee's model instead of the session's. A delegation the model sends to any other agent is left alone and keeps that agent's own prompt, tools and model.`,
  )
  return notes
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

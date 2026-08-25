import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import {
  applySeatSkills,
  COPILOT_SEAT_AGENT_MARKER,
  copilotSeatAgentName,
  copilotSeatAgentReference,
  readCopilotTarget,
  seatFor,
  seatTargets,
} from "@observer-ai/daemon"
import type { CopilotSeatTarget, SeatsConfig } from "@observer-ai/daemon"
import { behaviorDirective, getEmployee, ROSTER } from "@observer-ai/roster"
import { dataDir } from "@observer-ai/storage"
import { copilotHome } from "./paths.js"

const PLUGIN_NAME = "observer"
const GENERATED_FILE = /^observer-.+\.agent\.md$/
const SETTINGS_STATE_VERSION = 1

interface ManagedSettingsState {
  version: number
  agents: string[]
}

export interface CopilotSeatSync {
  written: string[]
  removed: string[]
  notes: string[]
}

export function copilotSettingsPath(): string {
  return join(copilotHome(), "settings.json")
}

export function copilotSeatStatePath(): string {
  return join(dataDir(), "copilot-seat-settings.json")
}

export function copilotPluginCacheDir(): string {
  return join(copilotHome(), "installed-plugins", "_direct", PLUGIN_NAME)
}

/** Plugin roots that exist and therefore need the generated agents reconciled. */
export function copilotSeatPluginDirs(): string[] {
  return [
    join(copilotHome(), "plugins", PLUGIN_NAME),
    copilotPluginCacheDir(),
  ].filter((path, index, all) => existsSync(join(path, "plugin.json")) && all.indexOf(path) === index)
}

/**
 * Reconciles Copilot's generated employee agents and Observer-owned settings.
 *
 * The installed plugin cache is updated as well as the staging copy because
 * Copilot loads the cache. Both are read at session startup, so callers must
 * still tell the user to restart.
 */
export function syncCopilotSeatAgents(seats: SeatsConfig): CopilotSeatSync {
  const notes: string[] = []
  const pluginRoots = copilotSeatPluginDirs()
  const roots = [copilotHome(), ...pluginRoots]
  const desired = desiredAgents(seats, notes)
  const written: string[] = []
  const removed: string[] = []

  const effective = new Map(desired)
  for (const name of desired.keys()) {
    const collision = pluginRoots
      .map((root) => join(root, "agents", `${name}.agent.md`))
      .find((path) => {
        const contents = readIfPresent(path)
        return contents !== undefined && !contents.includes(COPILOT_SEAT_AGENT_MARKER)
      })
    if (!collision) continue
    const agent = effective.get(name)
    if (agent) effective.set(name, { ...agent, target: undefined })
    notes.push(`${name} was not applied because ${collision} is not owned by Observer.`)
  }

  const previouslyManaged = new Set(readManagedState().agents)
  for (const root of roots) {
    const directory = join(root, "agents")
    for (const path of generatedFiles(directory)) previouslyManaged.add(agentNameFromPath(path))
    if (effective.size > 0) mkdirSync(directory, { recursive: true })

    for (const [name, agent] of effective) {
      const path = join(directory, `${name}.agent.md`)
      const before = readIfPresent(path)
      if (before === agent.contents) continue
      if (before !== undefined && !before.includes(COPILOT_SEAT_AGENT_MARKER)) {
        notes.push(`${path} was left unchanged because Observer does not own it.`)
        continue
      }
      writeFileSync(path, agent.contents)
      written.push(path)
    }

    for (const path of generatedFiles(directory)) {
      if (effective.has(agentNameFromPath(path))) continue
      rmSync(path, { force: true })
      removed.push(path)
    }
  }

  const settings = reconcileSettings(previouslyManaged, effective)
  notes.push(
    `${effective.size} Copilot employee agent${effective.size === 1 ? "" : "s"} available; unpinned agents inherit Copilot's model choice.`,
  )
  if (settings) notes.push(settings)
  if (written.length > 0 || removed.length > 0) {
    notes.push("Restart Copilot CLI and the Copilot app so agents and subagent settings reload.")
  }
  return { written, removed, notes }
}

/** Removes only settings entries whose ownership was recorded by Observer. */
export function removeCopilotSeatSettings(): string[] {
  const managed = new Set(readManagedState().agents)
  if (managed.size === 0) return []
  const note = reconcileSettings(managed, new Map())
  return note ? [note] : []
}

interface RenderedAgent {
  employeeId: string
  target?: CopilotSeatTarget
  contents: string
}

/** Removes Observer-owned personal Copilot employee agents on uninstall. */
export function removeCopilotEmployeeAgents(): string[] {
  const directory = join(copilotHome(), "agents")
  const removed: string[] = []
  for (const path of generatedFiles(directory)) {
    rmSync(path, { force: true })
    removed.push(path)
  }
  return removed
}

function desiredAgents(seats: SeatsConfig, notes: string[]): Map<string, RenderedAgent> {
  const desired = new Map<string, RenderedAgent>()
  for (const profile of ROSTER) {
    const id = profile.id
    const spec = seatFor(seats, id)
    const targets = spec
      ? Object.entries(seatTargets(spec)).filter(([, target]) => target?.host === "copilot")
      : []
    const usable = targets
      .map(([targetId, target]) => ({ targetId, target: readCopilotTarget(target) }))
      .filter((entry): entry is { targetId: string; target: CopilotSeatTarget } => entry.target !== undefined)
    if (usable.length > 1) {
      notes.push(
        `${id} has ${usable.length} Copilot targets (${usable.map((entry) => `"${entry.targetId}"`).join(", ")}); only "${usable[0]!.targetId}" was applied.`,
      )
    }

    const target = seats?.control === true ? usable[0]?.target : undefined
    const name = copilotSeatAgentName(id)
    desired.set(name, { employeeId: id, target, contents: renderAgent(seats, id, name, target) })
  }
  return desired
}

function renderAgent(seats: SeatsConfig, employeeId: string, name: string, target: CopilotSeatTarget | undefined): string {
  const profile = getEmployee(employeeId)
  if (!profile) throw new Error(`Unknown employee ${employeeId}`)
  const lines = [
    "---",
    `# ${COPILOT_SEAT_AGENT_MARKER} - generated by Observer for roster employee ${employeeId}.`,
    "# Edits are overwritten by `observer config`. Delete the marker above to keep this file.",
    `name: ${yaml(name)}`,
    `description: ${yaml(`${profile.fullName}, ${profile.title}. Use proactively when delegated work needs ${profile.fields.slice(0, 5).join(", ")}.`)}`,
    `tools: ["*"]`,
  ]
  if (target !== undefined) lines.push(`model: ${yaml(target.model)}`)
  lines.push(
    "---",
    "",
    behaviorDirective(applySeatSkills(profile, seats)),
    "",
    "Use `apply_patch` instead of the legacy `edit` and `create` tools for file changes so Copilot shows the unified diff interface.",
    "",
  )
  return lines.join("\n")
}

function reconcileSettings(previouslyManaged: Set<string>, desired: Map<string, RenderedAgent>): string | undefined {
  const path = copilotSettingsPath()
  const before = readIfPresent(path)
  if (before === undefined && ![...desired.values()].some((agent) => agent.target !== undefined)) {
    writeManagedState([])
    return undefined
  }

  let document: Record<string, unknown>
  try {
    const parsed = before === undefined ? {} : (JSON.parse(before) as unknown)
    if (!isRecord(parsed)) return "Copilot settings were not changed because settings.json is not an object."
    document = parsed
  } catch {
    return "Copilot settings were not changed because settings.json is not valid JSON."
  }

  const subagents = isRecord(document["subagents"]) ? { ...document["subagents"] } : {}
  const agents = isRecord(subagents["agents"]) ? { ...subagents["agents"] } : {}
  const desiredSettings = new Map(
    [...desired.values()]
      .filter((agent): agent is RenderedAgent & { target: CopilotSeatTarget } => agent.target !== undefined)
      .map((agent) => [copilotSeatAgentReference(agent.employeeId), agent]),
  )
  for (const name of previouslyManaged) {
    if (!desiredSettings.has(name)) delete agents[name]
  }
  for (const [name, agent] of desiredSettings) {
    agents[name] = {
      model: agent.target.model,
      ...(agent.target.effortLevel ? { effortLevel: agent.target.effortLevel } : {}),
      ...(agent.target.contextTier ? { contextTier: agent.target.contextTier } : {}),
    }
  }

  if (Object.keys(agents).length > 0) subagents["agents"] = agents
  else delete subagents["agents"]
  if (Object.keys(subagents).length > 0) document["subagents"] = subagents
  else delete document["subagents"]

  const next = `${JSON.stringify(document, null, 2)}\n`
  if (next !== before) atomicWriteIfUnchanged(path, before, next)
  writeManagedState([...desiredSettings.keys()])
  return `${desiredSettings.size} Observer-owned Copilot model pin${desiredSettings.size === 1 ? "" : "s"} reconciled.`
}

function atomicWriteIfUnchanged(path: string, expected: string | undefined, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.observer.tmp`
  try {
    writeFileSync(temp, contents, { mode: 0o600 })
    if (readIfPresent(path) !== expected) throw new Error("Copilot settings changed while Observer was preparing the update")
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function readManagedState(): ManagedSettingsState {
  try {
    const parsed = JSON.parse(readFileSync(copilotSeatStatePath(), "utf8")) as unknown
    if (!isRecord(parsed) || parsed["version"] !== SETTINGS_STATE_VERSION || !Array.isArray(parsed["agents"])) {
      return { version: SETTINGS_STATE_VERSION, agents: [] }
    }
    return {
      version: SETTINGS_STATE_VERSION,
      agents: parsed["agents"].filter((name): name is string => typeof name === "string"),
    }
  } catch {
    return { version: SETTINGS_STATE_VERSION, agents: [] }
  }
}

function writeManagedState(agents: string[]): void {
  const path = copilotSeatStatePath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify({ version: SETTINGS_STATE_VERSION, agents }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function generatedFiles(directory: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return []
  }
  return entries
    .filter((entry) => GENERATED_FILE.test(entry))
    .map((entry) => join(directory, entry))
    .filter((path) => readIfPresent(path)?.includes(COPILOT_SEAT_AGENT_MARKER))
}

function agentNameFromPath(path: string): string {
  return basename(path).replace(/\.agent\.md$/, "")
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

function yaml(value: string): string {
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { dataDir } from "@observer-ai/storage"
import type { CodexSkillInventory } from "@observer-ai/daemon"

const CACHE_VERSION = 1
const CACHE_FILE = "codex-skills.json"

interface CachedProjectSkills {
  cwd: string
  skills: CodexSkillInventory["skills"]
}

interface SkillCache {
  version: number
  projects: CachedProjectSkills[]
}

/**
 * Stores the inventory Codex resolved for one project so the synchronous
 * pre-spawn hook can pass it on without starting another Codex process.
 */
export function rememberCodexSkills(cwd: string, inventory: CodexSkillInventory): void {
  const directory = dataDir()
  const path = codexSkillCachePath()
  const project = resolve(cwd)
  const before = readCache(path)
  const projects = before.projects.filter((entry) => !samePath(entry.cwd, project))
  projects.push({ cwd: project, skills: inventory.skills })

  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify({ version: CACHE_VERSION, projects }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

export function codexSkillCachePath(): string {
  return resolve(dataDir(), CACHE_FILE)
}

function readCache(path: string): SkillCache {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!isRecord(raw) || raw["version"] !== CACHE_VERSION || !Array.isArray(raw["projects"])) return emptyCache()
    const projects = raw["projects"].flatMap((entry): CachedProjectSkills[] => {
      if (!isRecord(entry) || typeof entry["cwd"] !== "string" || !Array.isArray(entry["skills"])) return []
      return [{ cwd: entry["cwd"], skills: entry["skills"] as CodexSkillInventory["skills"] }]
    })
    return { version: CACHE_VERSION, projects }
  } catch {
    return emptyCache()
  }
}

function emptyCache(): SkillCache {
  return { version: CACHE_VERSION, projects: [] }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

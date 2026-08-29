#!/usr/bin/env node
/**
 * observer-codex-control - the synchronous decision hook for Codex spawns.
 *
 * It is deliberately separate from telemetry. Unknown events, tools, and
 * payload shapes produce no output and Codex proceeds unchanged.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { codexHookOutput } from "./codex-control-core.js"
import type { CodexSpawnControl, CodexSpawnSkill } from "./codex-control-core.js"
import { admitSubagent, type AdmissionConfig } from "./subagent-admission.js"

async function main(): Promise<void> {
  const payload = JSON.parse(readFileSync(0, "utf8")) as unknown
  const event = isRecord(payload) && typeof payload["hook_event_name"] === "string"
    ? payload["hook_event_name"]
    : "PreToolUse"
  const config = readObserverConfig()
  if (config) {
    const decision = await admitSubagent("codex", payload, config)
    if (decision.controlled && !decision.allowed) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason,
        },
      }))
      return
    }
  }
  const output = codexHookOutput(event, payload, readControl(payload, config))
  if (output) process.stdout.write(JSON.stringify(output))
}

main()
  .catch(() => {
    // A malformed non-spawn hook stays invisible. Spawn admission failures are
    // converted to a deny inside `admitSubagent` before they reach this path.
  })
  .finally(() => {
    process.exitCode = 0
  })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readObserverConfig(): AdmissionConfig | undefined {
  const directory = process.env["OBSERVER_HOME"]?.trim() || join(homedir(), ".observer")
  try {
    const value = JSON.parse(readFileSync(join(directory, "config.json"), "utf8")) as unknown
    if (!isRecord(value) || typeof value["port"] !== "number" || typeof value["token"] !== "string") return undefined
    return value as unknown as AdmissionConfig
  } catch {
    return undefined
  }
}

function readControl(payload: unknown, config: AdmissionConfig | undefined): CodexSpawnControl {
  const directory = process.env["OBSERVER_HOME"]?.trim() || join(homedir(), ".observer")
  const passAllSkills = config === undefined ? readPassAllSkills(join(directory, "config.json")) : (config as unknown as Record<string, unknown>)["passAllSkills"] !== false
  if (!passAllSkills) return { passAllSkills: false, skills: [] }

  const cwd = resolve(isRecord(payload) && typeof payload["cwd"] === "string" ? payload["cwd"] : process.cwd())
  return { passAllSkills: true, skills: readSkills(join(directory, "codex-skills.json"), cwd) }
}

function readPassAllSkills(path: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
    return !isRecord(raw) || raw["passAllSkills"] !== false
  } catch {
    return true
  }
}

function readSkills(path: string, cwd: string): CodexSpawnSkill[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!isRecord(raw) || raw["version"] !== 1 || !Array.isArray(raw["projects"])) return []
    const project = raw["projects"].find((entry) => isRecord(entry) && samePath(entry["cwd"], cwd))
    if (!isRecord(project) || !Array.isArray(project["skills"])) return []
    return project["skills"].flatMap((skill): CodexSpawnSkill[] => {
      if (!isRecord(skill)) return []
      const name = text(skill["name"])
      const skillPath = text(skill["path"])
      if (!name || !skillPath) return []
      return [{
        name,
        path: skillPath,
        description: text(skill["description"]) ?? "",
        scope: text(skill["scope"]) ?? "unknown",
      }]
    })
  } catch {
    return []
  }
}

function samePath(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false
  const left = resolve(value)
  return process.platform === "win32" ? left.toLowerCase() === expected.toLowerCase() : left === expected
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

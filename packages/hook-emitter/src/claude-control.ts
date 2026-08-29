#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { admitSubagent, type AdmissionConfig } from "./subagent-admission.js"

async function main(): Promise<void> {
  const payload = JSON.parse(readFileSync(0, "utf8")) as unknown
  const config = readConfig()
  if (!config) return
  const decision = await admitSubagent("claude", payload, config)
  if (!decision.controlled) return
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.allowed ? "allow" : "deny",
      ...(decision.reason ? { permissionDecisionReason: decision.reason } : {}),
    },
  }))
}

function readConfig(): AdmissionConfig | undefined {
  try {
    const directory = process.env["OBSERVER_HOME"]?.trim() || join(homedir(), ".observer")
    const value = JSON.parse(readFileSync(join(directory, "config.json"), "utf8")) as unknown
    if (!isRecord(value) || typeof value["port"] !== "number" || typeof value["token"] !== "string") return undefined
    return value as unknown as AdmissionConfig
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

main().catch(() => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Observer could not verify the configured subagent limits, so creation was blocked.",
    },
  }))
})

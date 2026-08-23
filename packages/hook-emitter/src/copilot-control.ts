#!/usr/bin/env node
/**
 * Synchronous Copilot delegation controller.
 *
 * Unlike observer-emit, this executable is allowed to write a hook decision to
 * stdout. Its contract is still fail-open: every malformed or unavailable
 * state emits `{}` and exits zero because a command-hook error denies the task.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { COPILOT_SEAT_AGENT_MARKER } from "@observer-ai/daemon"
import type { CopilotSeatTarget, SeatsConfig } from "@observer-ai/daemon"
import { controlCopilotDelegation } from "./copilot-control-core.js"

const STDIN_TIMEOUT_MS = 1_500
const MAX_PAYLOAD_BYTES = 2_000_000
const PLUGIN_NAME = "observer"

interface ObserverFile {
  guidance?: boolean
  seats?: SeatsConfig
}

function observerHome(): string {
  const override = process.env["OBSERVER_HOME"]
  return override && override.length > 0 ? override : join(homedir(), ".observer")
}

function copilotHome(): string {
  const override = process.env["COPILOT_HOME"]
  return override && override.length > 0 ? override : join(homedir(), ".copilot")
}

function readObserverConfig(): ObserverFile | undefined {
  try {
    const value = JSON.parse(readFileSync(join(observerHome(), "config.json"), "utf8")) as unknown
    return isRecord(value) ? (value as ObserverFile) : undefined
  } catch {
    return undefined
  }
}

function generatedAgentReady(name: string, reference: string, target: CopilotSeatTarget): boolean {
  const home = copilotHome()
  const cache = join(home, "installed-plugins", "_direct", PLUGIN_NAME)
  const roots = existsSync(cache) ? [cache] : [join(home, "plugins", PLUGIN_NAME)]
  const ownedAgentExists = roots.some((root) => {
    try {
      return readFileSync(join(root, "agents", `${name}.agent.md`), "utf8").includes(
        COPILOT_SEAT_AGENT_MARKER,
      )
    } catch {
      return false
    }
  })
  if (!ownedAgentExists) return false

  try {
    const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as unknown
    if (!isRecord(settings) || !isRecord(settings["subagents"])) return false
    const agents = settings["subagents"]["agents"]
    if (!isRecord(agents) || !isRecord(agents[reference])) return false
    const configured = agents[reference]
    return (
      configured["model"] === target.model &&
      configured["effortLevel"] === target.effortLevel &&
      configured["contextTier"] === target.contextTier
    )
  } catch {
    return false
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  return await new Promise<string>((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString("utf8"))
    }
    const timer = setTimeout(done, STDIN_TIMEOUT_MS)
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_PAYLOAD_BYTES) {
        done()
        return
      }
      chunks.push(chunk)
    })
    process.stdin.on("end", done)
    process.stdin.on("error", done)
  })
}

async function main(): Promise<unknown> {
  const raw = await readStdin()
  const config = readObserverConfig()
  if (!config || raw.trim().length === 0) return {}

  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!isRecord(input)) return {}

  return controlCopilotDelegation(input, config, generatedAgentReady) ?? {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

main()
  .catch(() => ({}))
  .then((output) => {
    process.stdout.write(JSON.stringify(output))
    process.exit(0)
  })

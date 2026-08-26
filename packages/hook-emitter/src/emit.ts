#!/usr/bin/env node
/**
 * observer-emit - the process a host hook actually runs.
 *
 * Design rules, in priority order:
 *  1. **Never break the agent.** Always exits 0 and never writes to stdout, so
 *     no host can interpret telemetry as a hook decision.
 *  2. **Never block.** Hard timeout on the daemon request; failures spool to
 *     disk and are drained when the daemon next starts.
 *  3. **Zero dependencies.** It runs on whatever Node the user already has and
 *     must stay cheap to start, because it runs on every tool call.
 *
 * Usage: observer-emit --host <host> --event <name> [--workspace <dir>]
 * The hook payload is read from stdin as JSON.
 */
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"

const REQUEST_TIMEOUT_MS = 1_500
const STDIN_TIMEOUT_MS = 2_000
const MAX_PAYLOAD_BYTES = 2_000_000

/**
 * How long one autostart attempt suppresses the next.
 *
 * A single prompt fires several hooks within milliseconds. Without a claim they
 * would each spawn a daemon and race for the port, and a daemon that is booting
 * but not yet listening would be mistaken for a dead one on every subsequent
 * hook. The window covers a cold boot with room to spare.
 */
const AUTOSTART_COOLDOWN_MS = 30_000

interface Config {
  port: number
  token: string
  autostart: boolean
}

function debug(message: string, error?: unknown): void {
  if (!process.env["OBSERVER_DEBUG"]) return
  process.stderr.write(`[observer-emit] ${message}${error ? `: ${String(error)}` : ""}\n`)
}

function dataDir(): string {
  const override = process.env["OBSERVER_HOME"]
  return override && override.length > 0 ? override : join(homedir(), ".observer")
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key || !key.startsWith("--")) continue
    const name = key.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      args[name] = next
      i++
    } else {
      args[name] = "true"
    }
  }
  return args
}

function readConfig(): Config | undefined {
  try {
    const raw = readFileSync(join(dataDir(), "config.json"), "utf8")
    const parsed = JSON.parse(raw) as Partial<Config>
    if (typeof parsed.port === "number" && typeof parsed.token === "string") {
      // Autostart is opt-out: a config written before the setting existed
      // should still bring the daemon up rather than silently spooling.
      return { port: parsed.port, token: parsed.token, autostart: parsed.autostart !== false }
    }
  } catch (error) {
    debug("config unavailable", error)
  }
  return undefined
}

/**
 * The daemon entry point, probed across both layouts Observer ships in.
 *
 * Mirrors `paths.ts` in the CLI, duplicated rather than imported because the
 * emitter takes no workspace dependencies: it runs on every tool call and must
 * stay a single file with nothing to resolve.
 */
function daemonEntry(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, "./daemon.js"), // published package: dist/daemon.js
    resolve(here, "../../../apps/daemon/dist/main.js"), // monorepo
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

/**
 * Claims the right to start the daemon, at most once per cooldown.
 *
 * The stamp is written before spawning rather than after, so a spawn that dies
 * on boot still costs one attempt instead of retrying on every hook.
 */
function claimAutostart(): boolean {
  const stamp = join(dataDir(), "autostart.stamp")
  try {
    if (Date.now() - statSync(stamp).mtimeMs < AUTOSTART_COOLDOWN_MS) return false
  } catch {
    // No stamp yet: the first hook through claims it.
  }
  try {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
    writeFileSync(stamp, `${Date.now()}\n`, { mode: 0o600 })
    return true
  } catch (error) {
    debug("autostart claim failed", error)
    return false
  }
}

/**
 * Brings the daemon up in the background so Observer needs no separate process.
 *
 * Deliberately fire-and-forget: the event that triggered this is already
 * spooled, and the daemon drains the spool on boot, so waiting here would only
 * add latency to the host's hook for no gain.
 */
function autostartDaemon(): void {
  const entry = daemonEntry()
  if (!entry) {
    debug("daemon build not found; cannot autostart")
    return
  }
  if (!claimAutostart()) return
  try {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
    const log = openSync(join(dataDir(), "daemon.log"), "a")
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
    })
    child.unref()
    debug(`autostarted daemon from ${entry}`)
  } catch (error) {
    debug("autostart failed", error)
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

function spool(body: string): void {
  try {
    const dir = join(dataDir(), "spool")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const day = new Date().toISOString().slice(0, 10)
    appendFileSync(join(dir, `${day}.jsonl`), `${body}\n`, { mode: 0o600 })
  } catch (error) {
    debug("spool failed", error)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const host = args["host"]
  const event = args["event"]
  if (!host || !event) {
    debug("missing --host or --event")
    return
  }

  const stdin = await readStdin()
  let payload: unknown = {}
  let payloadError: string | undefined
  if (stdin.trim().length > 0) {
    try {
      payload = JSON.parse(stdin)
    } catch (error) {
      // Keep the raw text and say why it could not be used. Reshaping it
      // silently would surface later as an event that simply never appeared.
      payload = { text: stdin.slice(0, 2000) }
      payloadError = error instanceof Error ? error.message : "payload is not valid JSON"
    }
  }

  const request = {
    host,
    event,
    payload,
    ...(payloadError ? { payloadError } : {}),
    deliveryId: randomUUID(),
    workspaceRoot: args["workspace"] ?? process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd(),
    hostVersion: args["hostVersion"],
    receivedAt: Date.now(),
  }
  const body = JSON.stringify(request)
  const config = readConfig()
  if (!config) {
    spool(body)
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body,
      signal: controller.signal,
    })
    if (!response.ok) {
      debug(`daemon responded ${response.status}`)
      spool(body)
    }
  } catch (error) {
    // Unreachable is the normal cold-start case, not just a fault: the user
    // opened an agent and Observer is not up yet. Spool first so the event
    // survives regardless, then bring the daemon up to drain it.
    debug("daemon unreachable", error)
    spool(body)
    if (config.autostart) autostartDaemon()
  } finally {
    clearTimeout(timer)
  }
}

main()
  .catch((error) => debug("unexpected failure", error))
  .finally(() => {
    // Explicit success: a non-zero exit could block a host's tool call.
    process.exitCode = 0
  })

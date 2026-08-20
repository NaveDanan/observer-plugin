#!/usr/bin/env node
/**
 * observer-emit - the process a host hook actually runs.
 *
 * Design rules, in priority order:
 *  1. **Never break the agent.** Always exits 0 and never writes to stdout, so
 *     no host can interpret Observer's output as a hook decision.
 *  2. **Never block.** Hard timeout on the daemon request; failures spool to
 *     disk and are drained when the daemon next starts.
 *  3. **Zero dependencies.** It runs on whatever Node the user already has and
 *     must stay cheap to start, because it runs on every tool call.
 *
 * Usage: observer-emit --host <host> --event <name> [--workspace <dir>]
 * The hook payload is read from stdin as JSON.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const REQUEST_TIMEOUT_MS = 1_500
const STDIN_TIMEOUT_MS = 2_000
const MAX_PAYLOAD_BYTES = 2_000_000

interface Config {
  port: number
  token: string
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
      return { port: parsed.port, token: parsed.token }
    }
  } catch (error) {
    debug("config unavailable", error)
  }
  return undefined
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
    debug("daemon unreachable", error)
    spool(body)
  } finally {
    clearTimeout(timer)
  }
}

main()
  .catch((error) => debug("unexpected failure", error))
  .finally(() => {
    // Explicit success: a non-zero exit could block or alter a host's tool call.
    process.exit(0)
  })

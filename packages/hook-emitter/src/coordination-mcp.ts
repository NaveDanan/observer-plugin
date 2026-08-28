#!/usr/bin/env node
import { createInterface } from "node:readline"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { handleCoordinationMcpRequest } from "./coordination-mcp-core.js"

declare const __OBSERVER_VERSION__: string

interface Config {
  port: number
  token: string
}

const host = argument("host")
const version = typeof __OBSERVER_VERSION__ === "string" ? __OBSERVER_VERSION__ : "dev"
const config = readConfig()

const api = {
  async get(path: string): Promise<unknown> {
    return request(path, "GET")
  },
  async post(path: string, body: unknown): Promise<unknown> {
    return request(path, "POST", body)
  },
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
lines.on("line", (line) => {
  void processLine(line)
})

async function processLine(line: string): Promise<void> {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
    return
  }

  if (Array.isArray(value)) {
    const responses = (await Promise.all(value.map((entry) => handleCoordinationMcpRequest(entry, { host, api, version })))).filter(
      (entry): entry is Record<string, unknown> => entry !== undefined,
    )
    if (responses.length > 0) write(responses)
    return
  }

  const response = await handleCoordinationMcpRequest(value, { host, api, version })
  if (response) write(response)
}

async function request(path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
  if (!config) throw new Error("Observer is not configured. Run `observer install` before using coordination tools.")
  let response: Response
  try {
    response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    throw new Error("Observer daemon is unavailable. Start it with `observer start` and retry.")
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof data["error"] === "string" ? data["error"] : `Observer daemon returned ${response.status}.`)
  return data
}

function readConfig(): Config | undefined {
  const root = process.env["OBSERVER_HOME"] || join(homedir(), ".observer")
  try {
    const value = JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as Partial<Config>
    if (typeof value.port === "number" && typeof value.token === "string" && value.token.length > 0) {
      return { port: value.port, token: value.token }
    }
  } catch {
    return undefined
  }
  return undefined
}

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && value.length > 0 ? value : "unknown"
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}


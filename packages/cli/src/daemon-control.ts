import { spawn } from "node:child_process"
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs"
import { dataDir, logPath, pidPath } from "@observer-ai/storage"
import { loadConfig } from "@observer-ai/daemon"
import { daemonPath } from "./paths.js"

export interface DaemonStatus {
  running: boolean
  port: number
  url: string
  pid: number | undefined
  events?: number
  faults?: number
  detail?: string
}

export interface DeliveryDiagnostics {
  accepted: number
  counters: Record<string, number>
  faults: number
  lastAcceptedByHost: Record<string, number>
  recent: Array<{ at: number; host: string; event: string; reason: string; detail?: string; payloadKeys: string[] }>
}

/** Fetches delivery diagnostics from a running daemon. */
export async function diagnostics(): Promise<DeliveryDiagnostics | undefined> {
  const config = loadConfig()
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/diagnostics`, {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return undefined
    return (await response.json()) as DeliveryDiagnostics
  } catch {
    return undefined
  }
}

export function readPid(): number | undefined {
  try {
    const value = Number(readFileSync(pidPath(), "utf8").trim())
    return Number.isFinite(value) && value > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function status(): Promise<DaemonStatus> {
  const config = loadConfig()
  const url = `http://127.0.0.1:${config.port}`
  const pid = readPid()
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })
    if (response.ok) {
      const body = (await response.json()) as { events?: number; faults?: number }
      return { running: true, port: config.port, url, pid, events: body.events, faults: body.faults }
    }
    return { running: false, port: config.port, url, pid, detail: `health returned ${response.status}` }
  } catch (error) {
    return {
      running: false,
      port: config.port,
      url,
      pid,
      detail: pid && isAlive(pid) ? "process is alive but not answering" : undefined,
    }
  }
}

/** Starts the daemon in the background and waits until it answers. */
export async function start(port?: number): Promise<DaemonStatus> {
  const current = await status()
  if (current.running) return current

  const entry = daemonPath()
  if (!existsSync(entry)) {
    throw new Error(`Daemon build not found at ${entry}. Run \`pnpm build\` first.`)
  }
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
  const out = openSync(logPath(), "a")
  const args = [entry, ...(port ? ["--port", String(port)] : [])]
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", out, out],
  })
  child.unref()

  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(150)
    const next = await status()
    if (next.running) return next
  }
  throw new Error(`Daemon did not become ready. See ${logPath()}`)
}

export async function stop(): Promise<boolean> {
  const pid = readPid()
  if (!pid || !isAlive(pid)) {
    rmSync(pidPath(), { force: true })
    return false
  }
  process.kill(pid, "SIGTERM")
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(100)
    if (!isAlive(pid)) break
  }
  rmSync(pidPath(), { force: true })
  return true
}

/** Opens a URL in the platform browser, ignoring failures on headless hosts. */
export function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" })
    child.unref()
  } catch {
    // Caller prints the URL as a fallback.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

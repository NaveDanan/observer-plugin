import { execFileSync } from "node:child_process"
import type { HostId } from "@observer-ai/protocol"

/** Process names each harness runs under. */
const PROCESS_NAMES: Array<[RegExp, HostId]> = [
  [/^opencode/i, "opencode"],
  [/^claude/i, "claude"],
  [/^codex/i, "codex"],
  [/^copilot/i, "copilot"],
]

/**
 * Environment markers a harness sets for commands it runs.
 *
 * Deliberately excluded: `CODEX_HOME`, `COPILOT_HOME` and `OBSERVER_HOME`.
 * Those are configuration overrides users export in shell profiles, so they say
 * nothing about who launched this process.
 */
const ENV_MARKERS: Array<[string[], HostId]> = [
  [["OPENCODE", "OPENCODE_PID"], "opencode"],
  [["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PROJECT_DIR", "CLAUDE_PLUGIN_ROOT"], "claude"],
  [["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_PLUGIN_ROOT"], "codex"],
  [["COPILOT_SESSION_ID", "COPILOT_AGENT_PROMPT", "GITHUB_COPILOT_CLI"], "copilot"],
]

export interface ProcessEntry {
  pid: number
  ppid: number
  name: string
}

/** Walks up the parent chain, nearest ancestor first. */
export function readProcessChain(startPid = process.pid, depth = 12): ProcessEntry[] {
  if (process.platform === "win32") return []
  const chain: ProcessEntry[] = []
  let pid = startPid
  for (let step = 0; step < depth && pid > 1; step++) {
    let line: string
    try {
      line = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).trim()
    } catch {
      break
    }
    const match = /^(\d+)\s+(.*)$/.exec(line)
    if (!match) break
    const ppid = Number(match[1])
    const name = (match[2] ?? "").trim()
    chain.push({ pid, ppid, name })
    if (!Number.isFinite(ppid) || ppid <= 1) break
    pid = ppid
  }
  return chain
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv
  chain?: ProcessEntry[]
}

/**
 * Detects the harness Observer was launched from.
 *
 * Observer is opened *by* a harness and stays bound to it, so this must find
 * the harness that actually ran the command.
 *
 * The parent process chain is authoritative and is checked first: harnesses
 * nest (a Claude Code session started from an OpenCode terminal inherits
 * `OPENCODE=1`), and only the process tree says which one is innermost.
 * Environment markers are the fallback for cases where the chain is
 * unavailable, such as Windows or a detached process.
 */
export function detectHarness(options: DetectOptions = {}): HostId | undefined {
  const env = options.env ?? process.env
  const chain = options.chain ?? readProcessChain()

  for (const entry of chain) {
    for (const [pattern, host] of PROCESS_NAMES) {
      if (pattern.test(entry.name)) return host
    }
  }

  for (const [keys, host] of ENV_MARKERS) {
    if (keys.some((key) => env[key])) return host
  }
  return undefined
}

/** Session id the harness is currently running, when it exposes one. */
export function detectSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env["CODEX_SESSION_ID"] ??
    env["CODEX_THREAD_ID"] ??
    env["COPILOT_SESSION_ID"] ??
    env["CLAUDE_CODE_BRIDGE_SESSION_ID"] ??
    undefined
  )
}

/** Builds the canvas URL, scoped to a harness when one is known. */
export function canvasUrl(base: string, scope: { host?: HostId; session?: string }): string {
  const url = new URL(base)
  if (scope.host) url.searchParams.set("host", scope.host)
  if (scope.session) url.searchParams.set("session", scope.session)
  return url.toString()
}

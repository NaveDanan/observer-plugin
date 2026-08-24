import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Which Copilot models *this account* may actually run.
 *
 * `copilot help config` lists every model the build knows how to name. It is a
 * catalogue of the product, not of the seat: on the machine this was written
 * against it named 23 models while the signed-in account could run 16 of them.
 * A picker built on `help config` alone therefore offers seven models that fail
 * at use time, which is the failure this module exists to prevent.
 *
 * ## Why this is not a `CopilotSpawn`
 *
 * `CopilotSpawn` documents, as a deliberate property, that it has no `input`
 * field — "a seam with no way to write to the child is a seam that cannot be
 * made to send a prompt, a token or a slash command by a later edit". The only
 * surface that answers the entitlement question is `copilot --acp`, a JSON-RPC
 * server that must be *spoken to* over stdin. Widening `CopilotSpawn` to allow
 * that would quietly delete the property for both existing probes, so this is a
 * second, separate seam whose ability to write to a child is the whole point
 * and is stated here rather than buried.
 *
 * What it may write is fixed: three JSON-RPC frames — `initialize`,
 * `session/new`, `session/close` — none of which carry a prompt, a credential
 * or a path beyond a temporary working directory. No caller-supplied text
 * reaches the child's stdin.
 *
 * ## Why the answer is never waited for
 *
 * The handshake costs about fifteen seconds against a real Copilot, and
 * `HostSeatAdapter` is synchronous because a promise there would reach the
 * installer, `syncSeatAgents` and every keystroke of the TUI's render path.
 * Fifteen seconds of frozen terminal to grey out seven rows is a bad trade, so
 * nothing here blocks: a stale or missing cache starts a detached refresh and
 * returns whatever is already known. The first open of a picker therefore greys
 * nothing out, and the next one is correct. `available === undefined` means
 * "nobody has answered yet", which every consumer already has to handle.
 *
 * ## Why it is cached on disk, unlike everything else in this adapter
 *
 * `session/new` creates a session that persists in the user's
 * `~/.copilot/session-store.db`, and `session/close` does not remove the row —
 * measured against the real CLI, not assumed. Every probe therefore leaves one
 * empty session behind in history the user owns. The adapter's in-memory
 * catalogue cache expires in ten minutes, which would mean a session every ten
 * minutes of use; a disk cache with a long life is what keeps it to about one a
 * day. Entitlement changes when a plan or an org policy changes, so a stale
 * answer of that age is a fair trade for not littering someone else's data.
 */
export interface CopilotEntitlement {
  /**
   * Bare model ids the account may run.
   *
   * Absent — not empty — when the question has not been answered. The
   * difference matters: an empty set would grey out every model, so a caller
   * must render every row normally rather than an entirely disabled list.
   */
  models?: Set<string>
  /** Where the answer came from. `unknown` means no answer yet, not "none". */
  freshness: "cached" | "unknown"
}

export type CopilotEntitlementProbe = (
  binary: string,
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => CopilotEntitlement

/**
 * How long a cached answer is trusted.
 *
 * Twelve hours, and the figure is set by the side effect rather than by
 * staleness: each refresh costs one empty session in the user's history, and a
 * seat's entitlement changes on the timescale of a billing plan.
 */
export const ENTITLEMENT_TTL_MS = 12 * 60 * 60_000

/**
 * How long after starting a refresh another may start.
 *
 * Several profiles, a daemon sync and an open picker can all ask within the
 * same second, and without this each would spawn its own child and leave its
 * own session behind.
 */
export const ENTITLEMENT_REFRESH_COOLDOWN_MS = 5 * 60_000

/** Wall-clock budget for the detached child, well past the measured ~15 s. */
const ENTITLEMENT_PROBE_TIMEOUT_MS = 45_000

/**
 * The ACP conversation, as source for a detached child.
 *
 * It runs in a child because the handshake is asynchronous and this adapter is
 * not. A `spawnSync` that merely writes both frames up front does not work:
 * measured against the real CLI, it answers `initialize` and then exits on
 * stdin EOF before `session/new` is ever served. The reply has to be waited
 * for, and the child is what waits.
 *
 * The child writes the cache itself, so the parent never has to learn the
 * outcome. Passed with `node -e`, so there is no file to install, resolve, or
 * keep in step with a bundler.
 */
const ACP_DRIVER = `
const plan = JSON.parse(process.argv[1])
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
let done = false
const finish = (ids) => {
  if (done) return
  done = true
  try {
    if (Array.isArray(ids) && ids.length > 0) {
      fs.mkdirSync(path.dirname(plan.cachePath), { recursive: true })
      fs.writeFileSync(plan.cachePath, JSON.stringify({ at: Date.now(), models: ids }), "utf8")
    }
  } catch {}
  try { child.kill() } catch {}
  process.exit(0)
}
const child = spawn(plan.command, plan.args, {
  stdio: ["pipe", "pipe", "ignore"],
  windowsVerbatimArguments: plan.verbatim,
  env: process.env,
  cwd: plan.cwd,
})
child.on("error", () => finish(undefined))
child.on("exit", () => finish(undefined))
const send = (id, method, params) => {
  try { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n") } catch {}
}
let buffer = ""
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString()
  let at
  while ((at = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    if (line.length === 0) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id === 1) {
      if (!message.result) return finish(undefined)
      send(2, "session/new", { cwd: plan.cwd, mcpServers: [] })
    }
    if (message.id === 2) {
      const result = message.result
      const models = result && result.models && result.models.availableModels
      if (result && typeof result.sessionId === "string") send(3, "session/close", { sessionId: result.sessionId })
      if (!Array.isArray(models)) return finish(undefined)
      const ids = models.map((m) => m && m.modelId).filter((id) => typeof id === "string" && id.length > 0)
      // A beat for session/close to land before the child is killed.
      setTimeout(() => finish(ids), 300)
    }
  }
})
send(1, "initialize", { protocolVersion: 1, clientCapabilities: { fs: {} } })
setTimeout(() => finish(undefined), plan.timeoutMs)
`

interface CachedEntitlement {
  at: number
  models: string[]
}

/** Where the answer is remembered between runs. */
export function entitlementCachePath(): string {
  const base =
    process.env["XDG_CACHE_HOME"] && process.env["XDG_CACHE_HOME"].length > 0
      ? process.env["XDG_CACHE_HOME"]
      : join(homedir(), ".cache")
  return join(base, "observer", "copilot-entitlement.json")
}

/** One launched refresh, described well enough for a test to assert on it. */
export interface EntitlementRefresh {
  execPath: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export interface EntitlementProbeOptions {
  /** Invocation builder, so Windows quoting stays in one place. */
  invocation: (binary: string) => { command: string; args: string[]; verbatim?: boolean }
  /** Clock, injected so cache expiry is testable without waiting. */
  now?: () => number
  /** Cache location override, so a test never touches a real one. */
  cachePath?: () => string
  /** Node executable to run the driver with. */
  execPath?: string
  /** Refresh launcher. Injected by tests; never a real Copilot in a test run. */
  launch?: (refresh: EntitlementRefresh) => void
}

/** When the last refresh was started, so several callers do not each start one. */
let lastRefreshAt = 0

/** Forgets the cooldown, so one test's refresh does not suppress the next one's. */
export function resetEntitlementCooldown(): void {
  lastRefreshAt = 0
}

/**
 * Reads the cache, and starts a refresh in the background when it is stale.
 *
 * Never blocks and never throws. A stale answer is still returned while the
 * refresh runs: a Copilot that is briefly unreachable is not evidence that the
 * account lost its models, and dropping to "unknown" would ungrey the whole
 * list for the duration of a hiccup.
 */
export function probeCopilotEntitlement(
  binary: string,
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
  deps: EntitlementProbeOptions,
): CopilotEntitlement {
  const now = deps.now ?? Date.now
  const cached = readCache((deps.cachePath ?? entitlementCachePath)())

  if (cached === undefined || now() - cached.at >= ENTITLEMENT_TTL_MS) {
    startRefresh(binary, options, deps, now)
  }
  if (cached === undefined) return { freshness: "unknown" }
  return { models: new Set(cached.models), freshness: "cached" }
}

function startRefresh(
  binary: string,
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
  deps: EntitlementProbeOptions,
  now: () => number,
): void {
  const at = now()
  if (lastRefreshAt !== 0 && at - lastRefreshAt < ENTITLEMENT_REFRESH_COOLDOWN_MS) return
  lastRefreshAt = at

  try {
    const plan = deps.invocation(binary)
    const payload = JSON.stringify({
      command: plan.command,
      args: plan.args,
      verbatim: plan.verbatim === true,
      // A directory Copilot will accept but that says nothing about the user's
      // work. The session this creates is filed under it.
      cwd: tmpdir(),
      cachePath: (deps.cachePath ?? entitlementCachePath)(),
      timeoutMs: ENTITLEMENT_PROBE_TIMEOUT_MS,
    })
    const refresh: EntitlementRefresh = {
      execPath: deps.execPath ?? process.execPath,
      args: ["-e", ACP_DRIVER, payload],
      env: options.env,
    }
    if (deps.launch !== undefined) {
      deps.launch(refresh)
      return
    }
    const child = spawn(refresh.execPath, refresh.args, {
      env: refresh.env,
      // Detached and disowned: this process must be free to exit, and a CLI
      // that has printed its output must not sit waiting on a background probe.
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  } catch {
    // A refresh that cannot be started costs the greying-out and nothing else.
  }
}

function readCache(path: string): CachedEntitlement | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return undefined
    const at = (parsed as { at?: unknown }).at
    const models = (parsed as { models?: unknown }).models
    if (typeof at !== "number" || !Array.isArray(models)) return undefined
    const ids = models.filter((id): id is string => typeof id === "string" && id.length > 0)
    if (ids.length === 0) return undefined
    return { at, models: ids }
  } catch {
    return undefined
  }
}

/** Writes an answer as if a refresh had produced it. For tests and tooling. */
export function writeEntitlementCache(path: string, models: readonly string[], at: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ at, models: [...models] }), "utf8")
  } catch {
    // A cache that cannot be written costs a probe next time and nothing else.
  }
}

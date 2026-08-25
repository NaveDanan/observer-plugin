import { emitKeypressEvents } from "node:readline"
import {
  LEGACY_TARGET_ID,
  createOpencodeAdapter,
  type HostSeatAdapter,
  type ModelCatalogue,
  type ObserverConfig,
  type SeatsConfig,
  loadConfig,
  readOpencodeTarget,
  saveConfig,
  seatAdapters,
  seatTargets,
} from "@observer-ai/daemon"
import { ROSTER } from "@observer-ai/roster"
import { loadTargetCatalogue, preloadCopilotCatalogues } from "./config-ui-catalogues.js"
import { type Viewport, render, renderReport } from "./config-ui-render.js"
import {
  type ConfigUIState,
  type EmployeeRow,
  type Key,
  type TargetProfile,
  applied,
  catalogueApplied,
  initialState,
  reduce,
} from "./config-ui-state.js"
import { listModels, refreshCopilotModelMetadata } from "./models.js"
import { syncSeatControl } from "./seat-control.js"
import { seatAgentDir } from "./seat-agents.js"
import { type Theme, buildTheme, colorSupport } from "./theme.js"
import { VERSION } from "./version.js"

/**
 * The terminal shell for `observer config`.
 *
 * Everything here is I/O and nothing here is behaviour: it reads the config,
 * feeds keypresses to `reduce`, writes what `render` returns, and performs the
 * one thing a pure function cannot. That split is why this file has no tests
 * and the other two have many — what is left to assert on here is Node's own
 * API, not Observer's.
 */

/**
 * Terminal control, and now colour.
 *
 * These two are still different things. Screen and cursor control is what
 * stops a full-screen UI scribbling over the user's scrollback, and it
 * happens whatever `NO_COLOR` says. Colour is decided once, here, by
 * `colorSupport`, and handed to the renderer as a theme — so the renderer
 * never reads the environment and a piped `observer config` gets exactly the
 * plain text it always did.
 */
const ALT_SCREEN_ON = "\u001B[?1049h"
const ALT_SCREEN_OFF = "\u001B[?1049l"
const CURSOR_HIDE = "\u001B[?25l"
const CURSOR_SHOW = "\u001B[?25h"
const HOME_AND_CLEAR = "\u001B[H\u001B[2J"

/** What the apply layer exposes, as this file needs it. */
type SyncSeatAgents = typeof syncSeatControl
type LoadTargetCatalogue = (targetId: string) => ModelCatalogue

export function rosterRows(): EmployeeRow[] {
  return ROSTER.map((profile) => ({ id: profile.id, name: profile.fullName, role: profile.title }))
}

export interface ConfigCommandOptions {
  /** Ask the host for its model list. Costs seconds; opt in with `--probe`. */
  probeHost?: boolean
}

/**
 * Runs `observer config`, interactively when it can and as a report when it
 * cannot.
 *
 * The non-TTY branch is not a courtesy. Raw mode on a pipe throws on some
 * platforms and blocks forever on others, and a command that hangs in CI is a
 * worse failure than one that never ran — the same reason the hook emitter
 * guards on `isTTY` before it reads stdin.
 */
export async function runConfig(options: ConfigCommandOptions = {}): Promise<number> {
  const config = loadConfig()
  const roster = rosterRows()
  const configured = Object.values(config.seats.employees)
    .map((seat) => readOpencodeTarget(seatTargets(seat)[LEGACY_TARGET_ID])?.model)
    .filter((model): model is string => typeof model === "string" && model.length > 0)
  const adapters = seatAdapters().map((adapter) =>
    adapter.kind === "opencode"
      ? createOpencodeAdapter({
          include: configured,
          readModels: (modelOptions) =>
            listModels({
              ...modelOptions,
              ...(options.probeHost === true ? { probeHost: true } : {}),
            }),
        })
      : adapter,
  )
  const profiles = targetProfiles(adapters)

  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    for (const line of renderReport(config.seats, roster, profiles)) process.stdout.write(`${line}\n`)
    return 0
  }

  const metadata = await refreshCopilotModelMetadata()
  const catalogues = preloadCopilotCatalogues(adapters, profiles)
  const welcome =
    metadata === "unavailable"
      ? "Copilot model context metadata could not be refreshed; model ids still come from Copilot."
      : metadata === "stale"
        ? "Using cached Copilot model context metadata because models.dev could not be refreshed."
        : undefined
  const state = initialState({
    seats: config.seats,
    roster,
    models: [],
    profiles,
    catalogues,
    ...(welcome === undefined ? {} : { welcome }),
  })

  return drive(
    config,
    state,
    syncSeatControl,
    (targetId) => loadTargetCatalogue(adapters, profiles, targetId),
    buildTheme(colorSupport(process.env, true)),
  )
}

function drive(
  config: ObserverConfig,
  start: ConfigUIState,
  sync: SyncSeatAgents | undefined,
  loadCatalogue: LoadTargetCatalogue,
  theme: Theme,
): Promise<number> {
  const stdin = process.stdin
  const stdout = process.stdout
  let state = start
  let saves = 0
  let restored = false

  const restore = (): void => {
    if (restored) return
    restored = true
    try {
      if (stdin.isTTY) stdin.setRawMode(false)
      stdin.pause()
      stdout.write(CURSOR_SHOW + ALT_SCREEN_OFF)
    } catch {
      // A terminal that has already gone away cannot be restored, and failing
      // to restore it must not become the error the user sees.
    }
  }

  // Registered before raw mode is entered, so nothing between here and the
  // event loop can leave a terminal with echo off and no cursor.
  process.once("exit", restore)
  process.once("SIGINT", () => {
    restore()
    process.exit(130)
  })
  process.once("SIGTERM", () => {
    restore()
    process.exit(143)
  })
  process.once("uncaughtException", (error: unknown) => {
    restore()
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(1)
  })

  const paint = (): void => {
    const viewport: Viewport = {
      rows: stdout.rows ?? 24,
      columns: stdout.columns ?? 100,
      theme,
      version: VERSION,
    }
    stdout.write(`${HOME_AND_CLEAR}${render(state, viewport).join("\n")}\n`)
  }

  return new Promise<number>((resolve) => {
    const finish = (): void => {
      stdin.off("keypress", onKey)
      stdout.off("resize", paint)
      restore()
      for (const line of farewell(state, saves)) process.stdout.write(`${line}\n`)
      resolve(0)
    }

    const onKey = (_sequence: string, key: Key | undefined): void => {
      const next = reduce(state, key ?? {})
      if (next === state) return
      state = next

      if (state.request === "catalogue" && state.targetId !== undefined) {
        const targetId = state.targetId
        try {
          state = catalogueApplied(state, targetId, loadCatalogue(targetId))
        } catch (error) {
          state = catalogueApplied(state, targetId, {
            models: [],
            source: targetId,
            freshness: "unknown",
            warnings: [
              `Observer could not read this target's models: ${error instanceof Error ? error.message : String(error)}`,
            ],
          })
        }
      }
      if (state.request === "save") {
        const outcome = save(config, state.seats, sync)
        if (outcome.saved) saves++
        state = applied(state, outcome)
      }

      if (state.request === "quit") {
        finish()
        return
      }
      paint()
    }

    emitKeypressEvents(stdin)
    stdin.setRawMode(true)
    stdin.resume()
    stdout.write(ALT_SCREEN_ON + CURSOR_HIDE)
    paint()
    stdin.on("keypress", onKey)
    stdout.on("resize", paint)
  })
}

function targetProfiles(adapters: HostSeatAdapter[]): TargetProfile[] {
  return adapters.flatMap((adapter) =>
    adapter.profiles().map((profile) => ({
      id: profile.id,
      host: adapter.kind,
      hostLabel: adapter.label,
      profileLabel:
        profile.label === adapter.label
          ? (profile.id.includes(":") ? profile.id.slice(profile.id.indexOf(":") + 1) : "default")
          : profile.label,
      capabilities: adapter.capabilities(profile.id),
    })),
  )
}

/**
 * Writes the seats and asks the apply layer to catch up.
 *
 * The config is re-read rather than reusing the object this process started
 * with: an `observer start` in another terminal may have rewritten the file
 * since, and losing someone's port change to save a model choice would be a
 * nasty trade. `saveConfig` is atomic and lossless, so the merge is a field
 * assignment and not a hand-rolled JSON write.
 */
function save(
  config: ObserverConfig,
  seats: SeatsConfig,
  sync: SyncSeatAgents | undefined,
): { saved: boolean; status: string } {
  try {
    const latest = loadConfig()
    latest.seats = seats
    saveConfig(latest)
    config.seats = seats
  } catch (error) {
    return { saved: false, status: `Could not save: ${error instanceof Error ? error.message : String(error)}` }
  }

  // The save has already happened. Anything the apply layer does or fails to
  // do from here is reported, never rolled back: the file on disk is the
  // user's config and a generated agent definition is a cache of it.
  return { saved: true, status: `Saved. ${applyNote(seats, sync)}` }
}

/**
 * What the apply layer did, in the words it chose.
 *
 * `syncSeatAgents` is called whether or not `control` is on, because turning
 * control *off* is precisely when stale `observer-*.md` definitions need
 * removing — leaving them behind would keep a host pointed at a model the
 * user has just said they no longer want applied.
 *
 * `notes` leads rather than `written.length`, on the apply layer's own
 * instruction: a run that finds every file already correct writes nothing and
 * reports `written: []`, so counting writes would tell a user "0 agent
 * definitions" about a config that is fully in force.
 */
function applyNote(seats: SeatsConfig, sync: SyncSeatAgents | undefined): string {
  if (sync === undefined) {
    return "Agent definitions were not regenerated: the apply layer is not present in this build."
  }
  try {
    const result = sync(seats)
    const churn: string[] = []
    if (result.written.length > 0) churn.push(`${result.written.length} written`)
    if (result.removed.length > 0) churn.push(`${result.removed.length} removed`)
    const suffix = churn.length > 0 ? ` (${churn.join(", ")})` : ""
    if (result.notes.length > 0) return `${result.notes.join(" ")}${suffix}`
    return seats.control
      ? `Employee definitions and model pins are up to date${suffix}.`
      : `Employee definitions are up to date${suffix}. Seat control is off, so the harness chooses their models. Skills apply anyway.`
  } catch (error) {
    return `Config saved, but agent definitions failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * The last thing on screen, after the alternate screen has been handed back.
 *
 * A full-screen UI takes its own output with it when it exits, so whatever
 * the user needs to carry away has to be said here, in the scrollback they
 * keep. With seat control on that includes the step Observer cannot take for
 * them: harnesses read native agent definitions at startup, so a session
 * already running will not see the ones this save just wrote.
 */
function farewell(state: ConfigUIState, saves: number): string[] {
  if (state.dirty) return ["Left without saving. The config on disk is unchanged."]
  if (saves === 0) return ["No changes."]
  if (!state.seats.control) {
    return ["Employees saved. Harnesses may use them with their own model choices; configured pins stay inactive."]
  }
  return [
    "Employees saved. Seat control is on, so configured employees pin the models you chose.",
    `OpenCode agent definitions live in ${seatAgentDir()}; other harnesses use their native agent directories.`,
    "Restart installed harnesses so they reload employee definitions.",
  ]
}

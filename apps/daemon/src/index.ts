import { mkdirSync, writeFileSync } from "node:fs"
import { Store, dataDir, databasePath, pidPath } from "@observer-ai/storage"
import { Broadcaster } from "./broadcaster.js"
import { loadConfig, saveConfig } from "./config.js"
import { CopilotTailer } from "./copilot-tailer.js"
import { Diagnostics } from "./diagnostics.js"
import { Pipeline } from "./pipeline.js"
import { SessionTitleTailer } from "./session-title-tailer.js"
import { createServer } from "./server.js"
import { drainSpool } from "./spool.js"

export interface StartedDaemon {
  url: string
  port: number
  token: string
  close(): Promise<void>
}

export interface StartOptions {
  port?: number
  webDir?: string
  /** Skip background readers for host-owned session data (used by tests). */
  tail?: boolean
}

/**
 * Boots the whole daemon: storage, ingest pipeline, HTTP/WebSocket API,
 * spool recovery and background maintenance.
 */
export async function startDaemon(options: StartOptions = {}): Promise<StartedDaemon> {
  const config = loadConfig()
  if (options.port && options.port !== config.port) {
    config.port = options.port
    saveConfig(config)
  }

  mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
  const store = new Store({ path: databasePath(), retentionDays: config.retentionDays })
  const broadcaster = new Broadcaster()
  const diagnostics = new Diagnostics()
  const pipeline = new Pipeline({
    store,
    config,
    diagnostics,
    onChanges: (changes) => broadcaster.publish(changes),
  })

  // Recover anything captured while the daemon was not running.
  const drained = drainSpool(pipeline)
  if (drained.accepted > 0) {
    process.stdout.write(`observer: replayed ${drained.accepted} spooled events\n`)
  }
  store.prune()

  const app = await createServer({ store, pipeline, config, broadcaster, diagnostics, webDir: options.webDir })
  await app.listen({ port: config.port, host: "127.0.0.1" })

  const copilotTailer = new CopilotTailer(store, pipeline)
  const titleTailer = new SessionTitleTailer(store, pipeline)
  if (options.tail !== false) {
    copilotTailer.start()
    titleTailer.start()
  }

  // Periodic maintenance: spool sweep for hooks that raced a restart, plus
  // retention pruning.
  const maintenance = setInterval(
    () => {
      try {
        drainSpool(pipeline)
        store.prune()
      } catch {
        // Never let maintenance kill the daemon.
      }
    },
    5 * 60 * 1000,
  )
  maintenance.unref()

  try {
    writeFileSync(pidPath(), String(process.pid), { mode: 0o600 })
  } catch {
    // A missing pid file only affects `observer stop` ergonomics.
  }

  return {
    url: `http://127.0.0.1:${config.port}`,
    port: config.port,
    token: config.token,
    async close() {
      clearInterval(maintenance)
      copilotTailer.stop()
      titleTailer.stop()
      broadcaster.closeAll()
      await app.close()
      store.close()
    },
  }
}

export { Pipeline } from "./pipeline.js"
export { Broadcaster } from "./broadcaster.js"
export { Diagnostics, FAULT_REASONS } from "./diagnostics.js"
export type { DiagnosticsSnapshot, DropReason, DropSample } from "./diagnostics.js"
export { createServer } from "./server.js"
export type { ServerOptions } from "./server.js"
export { loadConfig, saveConfig, DEFAULT_CONFIG, ConfigSchema, ConfigPatchSchema } from "./config.js"
export type { ObserverConfig, CaptureConfig } from "./config.js"
export {
  applySeatSkills,
  diagnoseOpencodeModel,
  diagnoseSeats,
  migrateSeatSpecToTargets,
  seatFor,
  seatTargets,
  DEFAULT_SEATS,
  LEGACY_TARGET_ID,
  SEAT_VARIANTS,
  SeatSpecSchema,
  SeatTargetSchema,
  SeatsConfigSchema,
} from "./seats.js"
export type {
  SeatDiagnosis,
  SeatIssue,
  SeatIssueCode,
  SeatIssueSeverity,
  SeatSpec,
  SeatTarget,
  SeatTargetOption,
  SeatVariant,
  SeatsConfig,
} from "./seats.js"
export { isHostKind, HOST_KINDS, ProviderInstanceConfigSchema, ProvidersConfigSchema } from "./providers.js"
export type { HostKind, ProviderInstanceConfig } from "./providers.js"
export {
  claudeAdapter,
  codexAdapter,
  copilotAdapter,
  createClaudeAdapter,
  createCodexAdapter,
  createCopilotAdapter,
  createOpencodeAdapter,
  fetchCodexSkills,
  copilotSeatAgentName,
  copilotSeatAgentReference,
  COPILOT_SEAT_AGENT_MARKER,
  opencodeAdapter,
  readCopilotTarget,
  readOpencodeTarget,
  seatAdapter,
  seatAdapters,
  CLAUDE_DEFAULT_PROFILE_ID,
  CODEX_DEFAULT_PROFILE,
  COPILOT_DEFAULT_PROFILE,
  OPENCODE_DEFAULT_PROFILE,
  OPENCODE_VARIANT_OPTION,
} from "./adapters/index.js"
export type {
  CatalogueModel,
  ClaudeAdapterOptions,
  ClaudeVersionRunner,
  CodexAdapterOptions,
  CodexAvailableSkill,
  CodexSkillDiscoveryOptions,
  CodexSkillInventory,
  CodexSpawn,
  CodexSpawnResult,
  ControlSupport,
  CopilotAdapterOptions,
  CopilotSeatTarget,
  CopilotSpawn,
  CopilotSpawnResult,
  DiscoveryMode,
  HostCapabilities,
  HostProfile,
  HostSeatAdapter,
  ModelCatalogue,
  ModelOptionChoice,
  ModelOptionDescriptor,
  OpencodeAdapterOptions,
  OpencodeSeatTarget,
} from "./adapters/index.js"
export { CopilotTailer } from "./copilot-tailer.js"
export { SessionTitleTailer, encodeClaudeProjectPath } from "./session-title-tailer.js"
export { drainSpool } from "./spool.js"
export * from "./models.js"

import { mkdirSync, writeFileSync } from "node:fs"
import { Store, dataDir, databasePath, pidPath } from "@observer-ai/storage"
import { Broadcaster } from "./broadcaster.js"
import { loadConfig, saveConfig } from "./config.js"
import { CopilotTailer } from "./copilot-tailer.js"
import { Diagnostics } from "./diagnostics.js"
import { Pipeline } from "./pipeline.js"
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
  /** Skip the Copilot session-log tailer (used by tests). */
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

  const tailer = new CopilotTailer(store, pipeline)
  if (options.tail !== false) tailer.start()

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
      tailer.stop()
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
export { loadConfig, saveConfig, DEFAULT_CONFIG } from "./config.js"
export type { ObserverConfig, CaptureConfig } from "./config.js"
export { CopilotTailer } from "./copilot-tailer.js"
export { drainSpool } from "./spool.js"

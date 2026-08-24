import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { configPath, dataDir } from "@observer-ai/storage"
import { z } from "zod"
import { ProvidersConfigSchema } from "./providers.js"
import type { ProviderInstanceConfig } from "./providers.js"
import { DEFAULT_SEATS, SeatsConfigSchema } from "./seats.js"
import type { SeatsConfig } from "./seats.js"

/**
 * What Observer is allowed to capture.
 *
 * Everything defaults to on because the product is useless without content,
 * but each switch is honoured at ingest time - disabled data is never written
 * to disk rather than merely hidden in the UI.
 */
export interface CaptureConfig {
  messages: boolean
  reasoning: boolean
  toolInput: boolean
  toolOutput: boolean
  prompts: boolean
  rawEvents: boolean
}

export interface ObserverConfig {
  port: number
  token: string
  retentionDays: number
  redaction: { enabled: boolean; maxTextLength: number }
  capture: CaptureConfig
  /**
   * Whether the OpenCode plugin offers the roster to the root agent.
   *
   * Declared here because the plugin has always read it off this file; while
   * it was undeclared, every `saveConfig` deleted it.
   */
  guidance: boolean
  /** Per-employee model, reasoning effort and skills. See `seats.ts`. */
  seats: SeatsConfig
  /** Configured provider instances, keyed by the user's instance id. */
  providers: Record<string, ProviderInstanceConfig>
  /**
   * Whether a hook may bring the daemon up when it finds nothing listening.
   *
   * On by default, so Observer is something a user installs rather than
   * something they remember to run. Turning it off does not lose events — the
   * emitter still spools them, and the next manual `observer start` drains the
   * spool.
   */
  autostart: boolean
}

export const CaptureConfigSchema = z.object({
  messages: z.boolean(),
  reasoning: z.boolean(),
  toolInput: z.boolean(),
  toolOutput: z.boolean(),
  prompts: z.boolean(),
  rawEvents: z.boolean(),
})

export const RedactionConfigSchema = z.object({
  enabled: z.boolean(),
  maxTextLength: z.number().int().min(0),
})

export const DEFAULT_CONFIG: Omit<ObserverConfig, "token"> = {
  port: 4599,
  retentionDays: 30,
  redaction: { enabled: true, maxTextLength: 64_000 },
  capture: {
    messages: true,
    // Raw chain-of-thought is off by default: it is the most sensitive and
    // least useful content to keep on disk.
    reasoning: false,
    toolInput: true,
    toolOutput: true,
    prompts: true,
    rawEvents: false,
  },
  guidance: true,
  seats: DEFAULT_SEATS,
  providers: {},
  autostart: true,
}

/**
 * Keys `loadConfig` read but does not understand, carried on the config object
 * so `saveConfig` can put them back.
 *
 * A symbol rather than a field: `JSON.stringify` ignores symbol keys, so this
 * can never leak into the file the user edits, and it stays off `ObserverConfig`
 * so the daemon's most-used type is not widened with an index signature. A
 * config built by hand simply has no symbol and merges nothing.
 *
 * Scope is the top level, which is where other components add keys — `guidance`
 * was one. Nested forward-compatibility is handled where it is actually needed:
 * `seats` preserves unknown employee ids and unknown seat fields in its schema.
 */
const UNKNOWN_KEYS = Symbol.for("observer.config.unknownKeys")

/**
 * Every value falls back on its own.
 *
 * `.catch()` per field rather than a whole-object parse is the point: a
 * corrupt config must not stop the daemon, and it must not cost the user the
 * settings that sit next to the broken one. A garbage `port` yields 4599 and
 * leaves `token` alone.
 */
export const ConfigSchema = z.object({
  port: z.number().int().min(1).max(65_535).catch(DEFAULT_CONFIG.port),
  // An unreadable token is regenerated, which is the one unavoidably
  // disruptive fallback: it invalidates every installed hook until they are
  // re-read. That is why `saveConfig` writes atomically.
  token: z.string().min(1).catch(() => createToken()),
  retentionDays: z.number().int().min(0).max(3_650).catch(DEFAULT_CONFIG.retentionDays),
  redaction: RedactionConfigSchema
    .extend({
      enabled: z.boolean().catch(DEFAULT_CONFIG.redaction.enabled),
      maxTextLength: z.number().int().min(0).catch(DEFAULT_CONFIG.redaction.maxTextLength),
    })
    .catch(DEFAULT_CONFIG.redaction),
  capture: CaptureConfigSchema
    .extend({
      messages: z.boolean().catch(DEFAULT_CONFIG.capture.messages),
      reasoning: z.boolean().catch(DEFAULT_CONFIG.capture.reasoning),
      toolInput: z.boolean().catch(DEFAULT_CONFIG.capture.toolInput),
      toolOutput: z.boolean().catch(DEFAULT_CONFIG.capture.toolOutput),
      prompts: z.boolean().catch(DEFAULT_CONFIG.capture.prompts),
      rawEvents: z.boolean().catch(DEFAULT_CONFIG.capture.rawEvents),
    })
    .catch(DEFAULT_CONFIG.capture),
  guidance: z.boolean().catch(DEFAULT_CONFIG.guidance),
  seats: SeatsConfigSchema,
  providers: ProvidersConfigSchema,
  autostart: z.boolean().catch(DEFAULT_CONFIG.autostart),
})

export const ConfigPatchSchema = z
  .object({
    capture: CaptureConfigSchema.optional(),
    retentionDays: z.number().int().min(0).max(3_650).optional(),
    redaction: RedactionConfigSchema.optional(),
    guidance: z.boolean().optional(),
    seats: SeatsConfigSchema.optional(),
    providers: ProvidersConfigSchema.optional(),
    autostart: z.boolean().optional(),
  })
  .strict()

const DECLARED_KEYS = new Set(Object.keys(ConfigSchema.shape))

/** Loads config, creating it with a fresh token on first run. */
export function loadConfig(): ObserverConfig {
  const path = configPath()
  if (existsSync(path)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
      const source = isRecord(raw) ? raw : {}
      const config = ConfigSchema.parse(source) as ObserverConfig
      const unknown: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(source)) {
        if (!DECLARED_KEYS.has(key)) unknown[key] = value
      }
      if (Object.keys(unknown).length > 0) {
        Object.defineProperty(config, UNKNOWN_KEYS, { value: unknown, enumerable: false, configurable: true })
      }
      return config
    } catch {
      // A corrupt config must not stop the daemon; fall through to defaults.
      // Only a JSON syntax error reaches here — every field-level problem is
      // already handled by its own `.catch()` above.
    }
  }
  const config: ObserverConfig = { ...DEFAULT_CONFIG, token: createToken() }
  saveConfig(config)
  return config
}

/**
 * Writes the config atomically: a full temp file, then a rename.
 *
 * A half-written config reads back as corrupt, which regenerates the auth
 * token and silently breaks every installed hook until the daemon restarts.
 * `rename(2)` within a directory is atomic, so a reader sees either the old
 * file or the new one and never a truncated one.
 *
 * The temp name carries the pid so two processes cannot clobber each other's
 * partial write; within one process, writes are synchronous and serialise.
 */
export function saveConfig(config: ObserverConfig): void {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
  const path = configPath()
  const temp = `${path}.${process.pid}.tmp`
  // Declared fields win: a key promoted from unknown to declared - as
  // `guidance` just was - must not be overwritten by its stale copy. Unknown
  // keys are appended rather than prepended so the file a user opens still
  // leads with the settings they recognise.
  const unknown = (config as unknown as Record<symbol, unknown>)[UNKNOWN_KEYS]
  const payload: Record<string, unknown> = { ...config }
  if (isRecord(unknown)) {
    for (const [key, value] of Object.entries(unknown)) {
      if (!(key in payload)) payload[key] = value
    }
  }
  try {
    // The mode is set at creation, so the token is never briefly world-readable.
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function createToken(): string {
  return randomBytes(24).toString("base64url")
}

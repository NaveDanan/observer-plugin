import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { configPath, dataDir } from "@observer-ai/storage"

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
}

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
}

/** Loads config, creating it with a fresh token on first run. */
export function loadConfig(): ObserverConfig {
  const path = configPath()
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ObserverConfig>
      return {
        port: parsed.port ?? DEFAULT_CONFIG.port,
        token: parsed.token ?? createToken(),
        retentionDays: parsed.retentionDays ?? DEFAULT_CONFIG.retentionDays,
        redaction: { ...DEFAULT_CONFIG.redaction, ...(parsed.redaction ?? {}) },
        capture: { ...DEFAULT_CONFIG.capture, ...(parsed.capture ?? {}) },
      }
    } catch {
      // A corrupt config must not stop the daemon; fall through to defaults.
    }
  }
  const config: ObserverConfig = { ...DEFAULT_CONFIG, token: createToken() }
  saveConfig(config)
  return config
}

export function saveConfig(config: ObserverConfig): void {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

function createToken(): string {
  return randomBytes(24).toString("base64url")
}

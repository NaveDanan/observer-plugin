import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configPath } from "@observer-ai/storage"
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "@observer-ai/daemon"
import type { ObserverConfig } from "@observer-ai/daemon"

let home: string
let originalHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer-config-"))
  originalHome = process.env["OBSERVER_HOME"]
  process.env["OBSERVER_HOME"] = home
})

afterEach(() => {
  if (originalHome === undefined) delete process.env["OBSERVER_HOME"]
  else process.env["OBSERVER_HOME"] = originalHome
  rmSync(home, { recursive: true, force: true })
})

/** Writes a raw config file, standing in for one a user or another tool wrote. */
function writeRaw(value: unknown): void {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, "config.json"), typeof value === "string" ? value : JSON.stringify(value, null, 2))
}

function readRaw(): Record<string, any> {
  return JSON.parse(readFileSync(join(home, "config.json"), "utf8"))
}

describe("config round-trip", () => {
  it("preserves an undeclared key across a load and a save", () => {
    writeRaw({ port: 4599, token: "tok", somethingNobodyDeclared: { nested: [1, 2] } })
    const config = loadConfig()
    saveConfig(config)
    expect(readRaw()["somethingNobodyDeclared"]).toEqual({ nested: [1, 2] })
  })

  it("keeps guidance:false through a save, the way `observer start --port` does it", () => {
    writeRaw({ port: 4599, token: "tok", guidance: false })
    const config = loadConfig()
    expect(config.guidance).toBe(false)
    config.port = 4600
    saveConfig(config)
    expect(readRaw()["guidance"]).toBe(false)
    expect(readRaw()["port"]).toBe(4600)
  })

  it("defaults guidance to true when the file does not mention it", () => {
    writeRaw({ port: 4599, token: "tok" })
    expect(loadConfig().guidance).toBe(true)
  })

  it("lets a declared field win over a stale copy of the same key", () => {
    // `guidance` was undeclared until now. A promoted key must be read from the
    // schema, not resurrected from the preserved-unknowns bag.
    writeRaw({ port: 4599, token: "tok", guidance: false })
    const config = loadConfig()
    config.guidance = true
    saveConfig(config)
    expect(readRaw()["guidance"]).toBe(true)
  })

  it("survives two consecutive round-trips without shedding the unknown key", () => {
    writeRaw({ port: 4599, token: "tok", experimental: "keep me" })
    saveConfig(loadConfig())
    saveConfig(loadConfig())
    expect(readRaw()["experimental"]).toBe("keep me")
  })

  it("never writes the internal unknown-key holder into the file", () => {
    writeRaw({ port: 4599, token: "tok", extra: 1 })
    saveConfig(loadConfig())
    const keys = Object.keys(readRaw())
    expect(keys).toContain("extra")
    expect(keys.some((key) => key.toLowerCase().includes("unknown"))).toBe(false)
  })
})

describe("config validation falls back per field", () => {
  it("falls back a garbage port to 4599 without throwing", () => {
    writeRaw({ port: "not a port", token: "tok" })
    const config = loadConfig()
    expect(config.port).toBe(4599)
    expect(config.token).toBe("tok")
  })

  it("rejects an out-of-range port the same way", () => {
    writeRaw({ port: 70_000, token: "tok" })
    expect(loadConfig().port).toBe(4599)
  })

  it("keeps the good capture switches when one of them is malformed", () => {
    writeRaw({ port: 4599, token: "tok", capture: { messages: "yes", reasoning: true } })
    const config = loadConfig()
    expect(config.capture.messages).toBe(DEFAULT_CONFIG.capture.messages)
    expect(config.capture.reasoning).toBe(true)
  })

  it("replaces a wholly wrong-typed section with its defaults", () => {
    writeRaw({ port: 4599, token: "tok", redaction: "off" })
    expect(loadConfig().redaction).toEqual(DEFAULT_CONFIG.redaction)
  })

  it("regenerates a missing token but leaves everything else alone", () => {
    writeRaw({ port: 4610, retentionDays: 7 })
    const config = loadConfig()
    expect(config.token.length).toBeGreaterThanOrEqual(20)
    expect(config.port).toBe(4610)
    expect(config.retentionDays).toBe(7)
  })

  it("does not throw on a syntactically broken file", () => {
    writeRaw("{ this is not json")
    expect(() => loadConfig()).not.toThrow()
    expect(loadConfig().port).toBe(4599)
  })

  it("does not throw when the file holds a JSON value that is not an object", () => {
    writeRaw("[1, 2, 3]")
    expect(() => loadConfig()).not.toThrow()
    expect(loadConfig().port).toBe(4599)
  })
})

describe("config is written atomically", () => {
  it("leaves the existing file intact when the write fails midway", () => {
    writeRaw({ port: 4599, token: "tok", guidance: false })
    const before = readFileSync(join(home, "config.json"), "utf8")
    const config = loadConfig()

    // Occupy the temp path with a directory so the write cannot land. This is
    // the failure the atomic path exists for: without it the truncated file is
    // the config, and the next load regenerates the auth token.
    mkdirSync(`${configPath()}.${process.pid}.tmp`)
    config.port = 4600
    expect(() => saveConfig(config)).toThrow()

    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before)
    expect(loadConfig().token).toBe("tok")
  })

  it("leaves no temp file behind on success or on failure", () => {
    const temp = `${configPath()}.${process.pid}.tmp`
    writeRaw({ port: 4599, token: "tok" })
    saveConfig(loadConfig())
    expect(existsSync(temp)).toBe(false)

    mkdirSync(temp)
    expect(() => saveConfig(loadConfig())).toThrow()
    // The occupying directory is ours to clear; the point is the config stands.
    rmSync(temp, { recursive: true, force: true })
    expect(readRaw()["token"]).toBe("tok")
  })

  it("keeps the private directory and file modes", () => {
    const config: ObserverConfig = { ...DEFAULT_CONFIG, token: "tok" }
    saveConfig(config)
    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(statSync(join(home, "config.json")).mode & 0o777).toBe(0o600)
  })

  it("creates the file on first run and reads back the same token", () => {
    const first = loadConfig()
    expect(existsSync(join(home, "config.json"))).toBe(true)
    expect(loadConfig().token).toBe(first.token)
  })
})

describe("the saved file stays readable by a human", () => {
  it("leads with the declared settings and appends the unknown ones", () => {
    writeRaw({ zzzUnknown: 1, port: 4599, token: "tok" })
    saveConfig(loadConfig())
    const keys = Object.keys(readRaw())
    expect(keys[0]).toBe("port")
    expect(keys.at(-1)).toBe("zzzUnknown")
  })
})

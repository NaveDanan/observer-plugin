import { describe, expect, it } from "vitest"
import { canvasUrl, detectHarness, detectSession, readProcessChain } from "../dist/index.js"

const noChain = { chain: [] }

describe("detectHarness", () => {
  it("uses the parent process chain, which is authoritative", () => {
    const chain = [
      { pid: 10, ppid: 9, name: "zsh" },
      { pid: 9, ppid: 1, name: "codex" },
    ]
    expect(detectHarness({ chain, env: {} })).toBe("codex")
  })

  it("prefers the innermost harness when they nest", () => {
    // A Claude Code session started inside an OpenCode terminal inherits
    // OPENCODE=1, so the environment alone would bind to the wrong harness.
    const chain = [
      { pid: 30, ppid: 20, name: "zsh" },
      { pid: 20, ppid: 10, name: "claude" },
      { pid: 10, ppid: 1, name: "opencode" },
    ]
    expect(detectHarness({ chain, env: { OPENCODE: "1", OPENCODE_PID: "10" } })).toBe("claude")
  })

  it("falls back to environment markers when the chain is unavailable", () => {
    expect(detectHarness({ ...noChain, env: { OPENCODE: "1" } })).toBe("opencode")
    expect(detectHarness({ ...noChain, env: { CLAUDECODE: "1" } })).toBe("claude")
    expect(detectHarness({ ...noChain, env: { CODEX_SESSION_ID: "thr_1" } })).toBe("codex")
    expect(detectHarness({ ...noChain, env: { COPILOT_SESSION_ID: "s1" } })).toBe("copilot")
  })

  it("returns nothing in a plain shell", () => {
    expect(detectHarness({ ...noChain, env: { PATH: "/usr/bin" } })).toBeUndefined()
    expect(detectHarness({ chain: [{ pid: 2, ppid: 1, name: "bash" }], env: {} })).toBeUndefined()
  })

  it("ignores configuration overrides that say nothing about the launcher", () => {
    expect(detectHarness({ ...noChain, env: { CODEX_HOME: "/home/me/.codex" } })).toBeUndefined()
    expect(detectHarness({ ...noChain, env: { COPILOT_HOME: "/home/me/.copilot" } })).toBeUndefined()
    expect(detectHarness({ ...noChain, env: { OBSERVER_HOME: "/home/me/.observer" } })).toBeUndefined()
  })

  it("reads the real environment and process chain when called with no arguments", () => {
    // Regression: a dual signature once made the default `{}` look like an
    // empty environment, so the fallback never saw process.env at all.
    const previous = process.env["CLAUDECODE"]
    process.env["CLAUDECODE"] = "1"
    try {
      // The chain wins if this test itself runs under a known harness, so accept
      // either outcome; what matters is that it is not undefined.
      expect(detectHarness()).toBeDefined()
    } finally {
      if (previous === undefined) delete process.env["CLAUDECODE"]
      else process.env["CLAUDECODE"] = previous
    }
  })
})

describe("readProcessChain", () => {
  it("walks real ancestors without throwing", () => {
    const chain = readProcessChain()
    if (process.platform === "win32") {
      expect(chain).toEqual([])
      return
    }
    expect(chain.length).toBeGreaterThan(0)
    expect(chain[0]?.pid).toBe(process.pid)
    // Every entry must be a usable record, or detection would silently misfire.
    for (const entry of chain) {
      expect(Number.isFinite(entry.ppid)).toBe(true)
      expect(typeof entry.name).toBe("string")
    }
  })
})

describe("detectSession", () => {
  it("returns the harness session id when one is exposed", () => {
    expect(detectSession({ CODEX_SESSION_ID: "thr_9" })).toBe("thr_9")
    expect(detectSession({ COPILOT_SESSION_ID: "cs_1" })).toBe("cs_1")
  })

  it("returns nothing when the harness does not expose one", () => {
    expect(detectSession({ OPENCODE: "1" })).toBeUndefined()
  })
})

describe("canvasUrl", () => {
  it("binds the canvas to a harness", () => {
    expect(canvasUrl("http://127.0.0.1:4599", { host: "codex" })).toBe("http://127.0.0.1:4599/?host=codex")
  })

  it("can target a specific session", () => {
    const url = canvasUrl("http://127.0.0.1:4599", { host: "claude", session: "abc" })
    expect(url).toContain("host=claude")
    expect(url).toContain("session=abc")
  })

  it("stays unbound when no harness is known", () => {
    expect(canvasUrl("http://127.0.0.1:4599", {})).toBe("http://127.0.0.1:4599/")
  })
})

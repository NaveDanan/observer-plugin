import { describe, expect, it } from "vitest"
import { DEFAULT_REDACTION, deriveGoal, normalizeTodoStatus, redactText, redactValue } from "@observer-ai/core"

describe("normalizeTodoStatus", () => {
  it("maps each host's vocabulary onto the shared set", () => {
    expect(normalizeTodoStatus("in_progress")).toBe("in_progress")
    expect(normalizeTodoStatus("inProgress")).toBe("in_progress")
    expect(normalizeTodoStatus("In Progress")).toBe("in_progress")
    expect(normalizeTodoStatus("done")).toBe("completed")
    expect(normalizeTodoStatus("cancelled")).toBe("cancelled")
    expect(normalizeTodoStatus("blocked")).toBe("blocked")
    expect(normalizeTodoStatus(undefined)).toBe("unknown")
    expect(normalizeTodoStatus("something-new")).toBe("unknown")
  })
})

describe("deriveGoal", () => {
  it("collapses whitespace and drops fenced code", () => {
    expect(deriveGoal("Fix   the\n\nbug ```js\nconst a = 1\n``` now")).toBe("Fix the bug now")
  })

  it("truncates long prompts with an ellipsis", () => {
    const goal = deriveGoal("x".repeat(500))
    expect(goal.length).toBe(240)
    expect(goal.endsWith("\u2026")).toBe(true)
  })
})

describe("redactText", () => {
  it("removes provider tokens", () => {
    expect(redactText("key sk-abcdefghijklmnopqrstuvwx")).toBe("key [redacted]")
    expect(redactText("token ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("token [redacted]")
    expect(redactText("aws AKIAIOSFODNN7EXAMPLE")).toBe("aws [redacted]")
  })

  it("removes secret-looking assignments but keeps the key name", () => {
    expect(redactText('API_KEY="supersecretvalue"')).toBe('API_KEY="[redacted]"')
    expect(redactText("DB_PASSWORD=hunter2hunter2")).toBe("DB_PASSWORD=[redacted]")
  })

  it("leaves ordinary text untouched", () => {
    const text = "Refactor the auth module and add tests"
    expect(redactText(text)).toBe(text)
  })

  it("removes private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nabcdef\n-----END RSA PRIVATE KEY-----"
    expect(redactText(pem)).toBe("[redacted]")
  })

  it("enforces the size cap", () => {
    const result = redactText("a".repeat(100), { ...DEFAULT_REDACTION, maxTextLength: 10 })
    expect(result.startsWith("aaaaaaaaaa")).toBe(true)
    expect(result).toContain("truncated 90 characters")
  })

  it("can be disabled while still capping size", () => {
    const options = { enabled: false, maxTextLength: 1000 }
    expect(redactText("sk-abcdefghijklmnopqrstuvwx", options)).toBe("sk-abcdefghijklmnopqrstuvwx")
  })
})

describe("redactValue", () => {
  it("walks nested structures", () => {
    const result = redactValue({ env: { TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123" }, list: ["ok"] })
    expect(result).toEqual({ env: { TOKEN: "[redacted]" }, list: ["ok"] })
  })

  it("stops at a depth limit instead of recursing forever", () => {
    const deep: Record<string, unknown> = {}
    let node = deep
    for (let i = 0; i < 20; i++) {
      const child: Record<string, unknown> = {}
      node["next"] = child
      node = child
    }
    expect(() => redactValue(deep)).not.toThrow()
  })
})

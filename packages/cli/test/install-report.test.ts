import { describe, expect, it } from "vitest"
import { LOGO_ROWS, buildTheme, renderInstallReport, type HostSection } from "../dist/index.js"

/**
 * The installer's report is a pure function of what the installer returned, so
 * these tests are a report and an assertion on lines of text — no host config
 * is written and no terminal is involved.
 */

const SGR = /\u001B\[[0-9;]*m/g
const strip = (text: string): string => text.replace(SGR, "")

const OPENCODE: HostSection = {
  label: "OpenCode",
  action: "updated",
  path: "/home/dev/.config/opencode/plugins/observer.js",
  notes: ["Restart OpenCode; plugins and agents load at startup."],
  warnings: [],
}

const COPILOT: HostSection = {
  label: "GitHub Copilot CLI",
  action: "installed",
  path: "/home/dev/.copilot/hooks/observer.json",
  notes: ["Copilot CLI loads hook files at startup; restart any running session."],
  warnings: [
    {
      message: "GitHub Copilot CLI is also configured the other way, which would record every event twice.",
      remedyLabel: "Remove one with:",
      remedy: "observer uninstall copilot --plugin",
    },
  ],
}

const report = (sections: HostSection[], command: "install" | "uninstall" = "install") => ({
  command,
  sections,
  footnotes: [],
})

describe("the install report", () => {
  it("opens with the wordmark, the version and what the run is doing", () => {
    const lines = renderInstallReport(report([OPENCODE]), { version: "0.9.12" })
    expect(lines[0]).toContain("Observer v0.9.12")
    expect(lines[1]).toContain("By NJ-Labs")
    expect(lines[2]).toContain("installing into 1 host")
    // The mark occupies the banner, whatever the text beside it says.
    expect(lines.slice(0, LOGO_ROWS).join("")).toContain("\u2588")
  })

  it("counts the hosts and names the direction of an uninstall", () => {
    const lines = renderInstallReport(report([OPENCODE, COPILOT], "uninstall"))
    expect(lines[2]).toContain("removing from 2 hosts")
    expect(lines.join("\n")).not.toContain("Hooks bring the daemon up")
  })

  it("gives every host its own block, headed by name and outcome", () => {
    const lines = renderInstallReport(report([OPENCODE, COPILOT])).map(strip)
    const heading = lines.findIndex((line) => line.includes("GitHub Copilot CLI") && line.includes("installed"))
    expect(heading).toBeGreaterThan(0)
    // The path sits under the heading rather than beside it.
    expect(lines[heading + 1]).toContain("/home/dev/.copilot/hooks/observer.json")
    expect(lines[heading - 1]).toBe("")
  })

  it("marks a conflict differently from an ordinary note", () => {
    const lines = renderInstallReport(report([COPILOT])).map(strip)
    expect(lines.some((line) => line.trimStart().startsWith("- Copilot CLI loads hook files"))).toBe(true)
    const warning = lines.findIndex((line) => line.trimStart().startsWith("!"))
    expect(warning).toBeGreaterThan(0)
    expect(lines.slice(warning, warning + 2).join(" ").replace(/\s+/g, " ")).toContain(
      "record every event twice",
    )
    expect(lines.join("\n")).toContain("Remove one with: observer uninstall copilot --plugin")
  })

  it("closes an install with the two lines that say what to do next", () => {
    const lines = renderInstallReport(report([OPENCODE])).map(strip)
    expect(lines.at(-2)).toContain("Hooks bring the daemon up on their own")
    expect(lines.at(-1)).toContain("observer start && observer open")
  })

  it("prints footnotes about the run before the closing lines", () => {
    const lines = renderInstallReport({
      command: "install",
      sections: [OPENCODE],
      footnotes: ["--plugin only applies to codex and copilot; other hosts were configured normally."],
    }).map(strip)
    const footnote = lines.findIndex((line) => line.includes("--plugin only applies"))
    const closing = lines.findIndex((line) => line.includes("Hooks bring the daemon up"))
    expect(footnote).toBeGreaterThan(0)
    expect(footnote).toBeLessThan(closing)
  })

  it("wraps notes to the terminal with a hanging indent, without breaking paths", () => {
    const path = "/home/dev/.config/opencode/agent/observer-arjun-mehta.md"
    const section: HostSection = {
      ...OPENCODE,
      notes: [`Seat control applies to general delegations only, and the definitions live in ${path}.`],
    }
    const lines = renderInstallReport(report([section]), { columns: 60 }).map(strip)
    const wrapped = lines.filter((line) => line.includes("Seat control") || line.includes(path))
    expect(wrapped.length).toBeGreaterThan(1)
    // Only a word too long for the terminal is allowed past the right edge.
    for (const line of lines) {
      const longest = Math.max(0, ...line.trim().split(" ").map((word) => word.length))
      expect(line.length).toBeLessThanOrEqual(Math.max(60, longest + 6))
    }
    // A path is never split across two lines: it has to stay copyable.
    expect(lines.some((line) => line.includes(path))).toBe(true)
  })

  it("emits no ANSI without a theme, and the same text with one", () => {
    const plain = renderInstallReport(report([COPILOT]), { version: "0.9.12" })
    const coloured = renderInstallReport(report([COPILOT]), { version: "0.9.12", theme: buildTheme("truecolor") })
    for (const line of plain) expect(line).not.toContain("\u001B[38;")
    expect(coloured.some((line) => line.includes("\u001B[38;"))).toBe(true)
    expect(coloured.map(strip)).toEqual(plain)
  })
})

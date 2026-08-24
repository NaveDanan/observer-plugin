import { describe, expect, it } from "vitest"
import { parseAnsiLines } from "../src/chat/ansi"

describe("parseAnsiLines", () => {
  it("renders standard colors and resets them", () => {
    expect(parseAnsiLines("plain \u001b[31mred\u001b[0m plain")).toEqual([
      [
        { text: "plain " },
        { text: "red", foreground: "#cd3131" },
        { text: " plain" },
      ],
    ])
  })

  it("supports 256-color and true-color output", () => {
    expect(parseAnsiLines("\u001b[38;5;45mcyan\u001b[48;2;12;34;56m block")).toEqual([
      [
        { text: "cyan", foreground: "rgb(0 215 255)" },
        { text: " block", foreground: "rgb(0 215 255)", background: "rgb(12 34 56)" },
      ],
    ])
  })

  it("carries styles across lines for tail previews", () => {
    expect(parseAnsiLines("\u001b[1;32mfirst\nsecond")).toEqual([
      [{ text: "first", foreground: "#0dbc79", bold: true }],
      [{ text: "second", foreground: "#0dbc79", bold: true }],
    ])
  })

  it("removes non-printing terminal control sequences", () => {
    expect(parseAnsiLines("before\u001b]0;window title\u0007after\u001b[2K")).toEqual([[{ text: "beforeafter" }]])
  })
})

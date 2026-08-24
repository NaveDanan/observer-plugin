import { describe, expect, it } from "vitest"
import { LOGO_COLUMNS, LOGO_ROWS, logo, logoInkIsRowConstant, xtermSlot } from "../dist/index.js"

/**
 * The mark is a drawing, so these tests assert the two things a drawing has to
 * keep — its shape without colour, and its shape with colour — rather than
 * trying to describe how it looks.
 */

const SGR = /\u001B\[[0-9;]*m/g
const strip = (text: string): string => text.replace(SGR, "")

describe("the NJ mark", () => {
  it("draws eight rows of pixels in four rows of terminal", () => {
    expect(LOGO_ROWS).toBe(4)
    expect(logo("plain")).toHaveLength(4)
  })

  it("is the same drawing at every colour depth", () => {
    // The whole reason the shading is quantised to terminal rows. Strip the
    // paint and the coloured mark has to be the plain mark exactly, or
    // NO_COLOR gets a different, worse picture than the screen does.
    expect(logo("truecolor").map(strip)).toEqual(logo("plain"))
    expect(logo("256").map(strip)).toEqual(logo("plain"))
  })

  it("keeps every row the same width, so text beside it stays in a column", () => {
    for (const row of logo("plain")) expect(row.length).toBe(LOGO_COLUMNS)
    for (const row of logo("truecolor")) expect(strip(row).length).toBe(LOGO_COLUMNS)
  })

  it("draws an N and a J out of half blocks", () => {
    expect(logo("plain")).toEqual([
      "\u2588\u2588\u2580\u2588\u2584      \u2588\u2588       \u2588\u2588",
      "\u2588\u2588  \u2580\u2588\u2584    \u2588\u2588       \u2588\u2588",
      "\u2588\u2588    \u2580\u2588\u2584  \u2588\u2588  \u2584    \u2588\u2588",
      "\u2588\u2588      \u2580\u2588\u2584\u2588\u2588  \u2580\u2588\u2584\u2584\u2584\u2588\u2588",
    ])
  })

  it("moves the N's diagonal twice per terminal row", () => {
    // A diagonal that steps once per row is the staircase the solid-block mark
    // already drew, and the half blocks would have bought nothing.
    const starts = logo("plain").map((row) => row.indexOf("\u2580"))
    expect(starts).toEqual([2, 4, 6, 8])
  })

  it("never straddles a cell with two inks", () => {
    expect(logoInkIsRowConstant()).toBe(true)
  })

  it("paints no background, so the terminal's own stays visible", () => {
    // A TUI that fills its background repaints the user's theme. The mark is
    // foreground only; transparent pixels are spaces, not painted blocks.
    for (const row of logo("truecolor")) expect(row).not.toContain("\u001B[48;")
    for (const row of logo("256")) expect(row).not.toContain("\u001B[48;")
  })

  it("emits no colour at all when the terminal takes none", () => {
    for (const row of logo("plain")) expect(row).not.toContain("\u001B")
  })

  it("paints a run of cells in one span rather than one escape each", () => {
    // Four cells of the left pillar share an ink; four escape sequences to say
    // so would quadruple the line to draw the same thing.
    const row = logo("truecolor")[0]!
    expect(row.match(SGR)?.length ?? 0).toBeLessThan(strip(row).length)
  })

  it("falls back to indexed colour where truecolor is not on offer", () => {
    for (const row of logo("256")) {
      expect(row).not.toContain("\u001B[38;2;")
      if (row.includes("\u001B")) expect(row).toContain("\u001B[38;5;")
    }
  })
})

describe("xtermSlot", () => {
  it("finds the cube corner for a saturated colour", () => {
    expect(xtermSlot([255, 255, 255])).toBe(231)
    expect(xtermSlot([0, 0, 0])).toBe(16)
  })

  it("prefers the grey ramp for a near-grey, which the cube cannot match", () => {
    // The cube's grey steps are 40 apart; the ramp's are 10.
    expect(xtermSlot([118, 118, 118])).toBeGreaterThanOrEqual(232)
  })

  it("stays out of slots 0-15, which the user's theme has redefined", () => {
    for (const ink of [
      [15, 23, 42],
      [36, 56, 86],
      [80, 110, 150],
      [0, 225, 255],
      [160, 245, 255],
    ] as const) {
      expect(xtermSlot(ink)).toBeGreaterThanOrEqual(16)
    }
  })

  it("gives different slots to inks the eye tells apart", () => {
    const slots = new Set(
      ([
        [36, 56, 86],
        [52, 75, 108],
        [80, 110, 150],
        [0, 160, 200],
        [0, 225, 255],
        [160, 245, 255],
      ] as const).map(xtermSlot),
    )
    expect(slots.size).toBe(6)
  })
})

/** The Observer mark, rendered from a 24 by 16 pixel grid with half blocks. */

import { type ColorMode, type RGB, xtermSlot } from "./theme.js"

/**
 * The inks, dark to bright, slate into cyan.
 *
 * `null` is transparent rather than black: the mark sits on whatever the
 * user's terminal background is, and an explicit black would punch a hole in
 * it on every light theme.
 */
const PALETTE: Record<string, RGB | null> = {
  ".": null,
  "#": [15, 23, 42],
  d: [36, 56, 86],
  m: [52, 75, 108],
  l: [80, 110, 150],
  c: [0, 160, 200],
  C: [0, 225, 255],
  h: [160, 245, 255],
  W: [255, 255, 255],
}

/**
 * One character per source pixel. Two source rows become one terminal row.
 * Different colors in the same cell use foreground and background ink around
 * an upper-half block, which preserves the white and cyan diagonal highlight.
 */
const GRID: readonly string[] = [
  ".######..........######.",
  ".##WhCCc#........#CCCC#.",
  ".#m#WhCCc#.......#CCCW#.",
  ".#mm#WhCCc#......#CCWh#.",
  ".#mmm#WhCCc#.....#CWhC#.",
  ".#mmmm#WhCCc#....#WhCC#.",
  ".#mmmm##WhCCc#...#hCCC#.",
  ".#mmml#.#WhCCc#..#CCCC#.",
  ".#mmld#..#WhCCc#.#CCCc#.",
  ".#mldd#...#WhCCc##CCcc#.",
  ".#lddd#....#WhCCc#Cccc#.",
  ".#dddd#.....#WhCCc#ccc#.",
  ".#dddd#......#WhCCc#cc#.",
  ".#dddd#.......#WhCCc#c#.",
  ".#dddd#........#WhCCc##.",
  ".######.........#######.",
]
/** How many terminal rows the mark occupies: two pixel rows per row. */
export const LOGO_ROWS = Math.ceil(GRID.length / 2)

/** How many columns wide the mark is, for callers laying out beside it. */
export const LOGO_COLUMNS = Math.max(...GRID.map((row) => row.length))

const UPPER = "\u2580"
const LOWER = "\u2584"
const FULL = "\u2588"
const RESET = "\u001B[0m"

/**
 * The mark as terminal rows, at the colour depth the terminal can take.
 *
 * Two passes rather than one: resolve every cell to a glyph and an ink, then
 * emit one escape per *run of one ink*. A `\u2580\u2588\u2584` staircase is
 * three different glyphs in a single colour, so coalescing on the pixel pair
 * would spend three escape sequences saying one thing.
 */
export function renderLogo(depth: ColorMode): string[] {
  const rows: string[] = []
  for (let y = 0; y < GRID.length; y += 2) {
    const cells = resolveRow(GRID[y] ?? "", GRID[y + 1] ?? "", depth)
    let line = ""
    let at = 0
    while (at < cells.length) {
      const foregroundInk = cells[at]!.foreground
      const backgroundInk = cells[at]!.background
      let end = at
      let glyphs = ""
      while (
        end < cells.length &&
        sameOrBothNull(cells[end]!.foreground, foregroundInk) &&
        sameOrBothNull(cells[end]!.background, backgroundInk)
      ) {
        glyphs += cells[end]!.glyph
        end += 1
      }
      if (foregroundInk === null || depth === "plain") line += glyphs
      else {
        const paint = backgroundInk === null
          ? foreground(foregroundInk, depth)
          : `${foreground(foregroundInk, depth)}${background(backgroundInk, depth)}`
        line += `${paint}${glyphs}${RESET}`
      }
      at = end
    }
    if (depth !== "plain" && line.includes("\u001B[") && !line.endsWith(RESET)) line += RESET
    rows.push(line)
  }
  return rows
}

interface Cell {
  glyph: string
  foreground: RGB | null
  background: RGB | null
}

/** Resolve two source-pixel rows into glyphs and terminal paint. */
function resolveRow(top: string, bottom: string, depth: ColorMode): Cell[] {
  const cells: Cell[] = []
  for (let x = 0; x < LOGO_COLUMNS; x += 1) {
    const above = PALETTE[top[x] ?? "."] ?? null
    const below = PALETTE[bottom[x] ?? "."] ?? null
    if (above === null && below === null) cells.push({ glyph: " ", foreground: null, background: null })
    else if (above !== null && below !== null) {
      if (depth === "plain" || sameInk(above, below)) {
        cells.push({ glyph: FULL, foreground: above, background: null })
      } else {
        cells.push({ glyph: UPPER, foreground: above, background: below })
      }
    } else if (above !== null) cells.push({ glyph: UPPER, foreground: above, background: null })
    else cells.push({ glyph: LOWER, foreground: below, background: null })
  }
  return cells
}

function sameOrBothNull(left: RGB | null, right: RGB | null): boolean {
  if (left === null || right === null) return left === right
  return sameInk(left, right)
}

function sameInk(left: RGB, right: RGB): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2]
}

function foreground(ink: RGB, depth: ColorMode): string {
  return depth === "truecolor"
    ? `\u001B[38;2;${ink[0]};${ink[1]};${ink[2]}m`
    : `\u001B[38;5;${xtermSlot(ink)}m`
}

function background(ink: RGB, depth: Exclude<ColorMode, "plain">): string {
  return depth === "truecolor"
    ? `\u001B[48;2;${ink[0]};${ink[1]};${ink[2]}m`
    : `\u001B[48;5;${xtermSlot(ink)}m`
}

/**
 * The mark at each depth, drawn once.
 *
 * There are only three answers and they never change, so the alternative is
 * rebuilding the same 24-by-16 bitmap on every repaint.
 */
const CACHE: Record<ColorMode, string[]> = {
  plain: renderLogo("plain"),
  "256": renderLogo("256"),
  truecolor: renderLogo("truecolor"),
}

/** The mark for a terminal of this depth. */
export function logo(depth: ColorMode): string[] {
  return CACHE[depth]
}

/** The gap between the mark and the text set beside it. */
const WORDMARK_GAP = "   "

/**
 * The mark with text set beside it, one line per row.
 *
 * Every screen that opens with the wordmark does the same thing with it: eight
 * terminal rows, with styled text beside the first few. Keeping that layout
 * here prevents two copies of the arithmetic from drifting apart. Lines are
 * taken styled rather than as plain strings so the caller
 * keeps its own palette roles; a row with no text is left as the bare mark
 * rather than padded, because trailing spaces are what a copied terminal
 * transcript shows as ragged.
 */
export function wordmark(depth: ColorMode, lines: readonly string[]): string[] {
  return logo(depth).map((glyph, at) => {
    const beside = lines[at] ?? ""
    return beside.length === 0 ? glyph : `${glyph}${WORDMARK_GAP}${beside}`
  })
}

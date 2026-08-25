/**
 * The `NJ` wordmark, as a bitmap drawn with half-block characters.
 *
 * A terminal cell is roughly twice as tall as it is wide, so a mark drawn one
 * pixel per cell is squashed and coarse. `\u2580` (upper half block) splits a
 * cell in two: paint the top half with the foreground colour and the bottom
 * half with the background colour and one row of cells carries two rows of
 * pixels. The mark below is eight pixels tall in four terminal rows — the same
 * height the solid-block version occupied, at twice the vertical detail.
 *
 * Four rows is the ceiling as well as the floor. Every row here is a row the
 * model list underneath does not get on an 80x24 terminal, which is why this
 * is not simply drawn bigger: the resolution is bought with the glyph, not
 * with screen space.
 *
 * Three properties this has to keep, all of them learned the hard way:
 *
 *  - **The shape survives without colour.** Strip the theme and each cell
 *    still resolves to `\u2580`, `\u2584`, `\u2588` or a space depending on
 *    which halves are inked, so the silhouette reads as `NJ` under `NO_COLOR`,
 *    through a pipe and on a terminal from 1991. Colour is the overlay it is
 *    everywhere else in this UI, never the thing carrying the meaning.
 *  - **A transparent half paints no background.** The rest of the UI refuses
 *    to fill the screen, because a TUI that paints its own background repaints
 *    the user's terminal theme. A cell whose bottom pixel is empty is drawn
 *    with a foreground colour only, so the user's own background shows through
 *    everywhere the mark is not.
 *  - **Runs are painted in one span.** A per-cell escape sequence would
 *    quadruple the line's length to draw the same thing, and it is nested SGR
 *    that cost the selection band its background once already.
 */

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
}

/**
 * The mark, one character per pixel, twenty-two wide and eight tall.
 *
 * Written out rather than generated, because it is a drawing: it is easier to
 * fix by looking at it than by adjusting the arithmetic that would have
 * produced it.
 *
 * The gradient runs dark into bright, left to right — slate in the `N`'s left
 * pillar, crossing to ion cyan along the diagonal, cyan through the `J`. Within
 * each stroke the top is lighter and the bottom darker, which is the whole of
 * the bevel; at eight pixels there is no room for both a border and a bevel,
 * and it is the bevel that stops the letters reading as flat bars.
 *
 * **The ink is constant down each pair of rows**, and that is load-bearing
 * rather than incidental. A cell holding two *different* inks can only be
 * drawn as `\u2580` with the lower ink behind it — which looks solid in
 * colour and half-empty once the colour is stripped. Keeping the shading on
 * terminal-row boundaries means the coloured mark and the plain mark are the
 * same glyphs, so `NO_COLOR` and a pipe get the identical drawing rather than
 * a moth-eaten version of it. The shape still has all eight rows of detail;
 * only the shading is quantised, and four bands is more than this reads at.
 *
 * The `N`'s diagonal is what the extra resolution was bought for. It is two
 * pixels wide and steps one column per *pixel* row, so it advances twice per
 * terminal row: at one step per row it would be the same staircase the
 * solid-block mark drew, and there would be no reason to do any of this. It
 * closes flush against the right pillar on the last row, because a diagonal
 * that stops short reads as `\u0418`.
 *
 * The `J`'s hook runs left along the bottom and turns back up for two pixels
 * on the far left, which is what stops it reading as an `L`.
 */
const GRID: readonly string[] = [
  "llmm.......hh" + ".." + ".....hh",
  "ll.mm......hh" + ".." + ".....hh",
  "mm..ll.....CC" + ".." + ".....CC",
  "mm...ll....CC" + ".." + ".....CC",
  "mm....cc...CC" + ".." + ".....CC",
  "mm.....cc..CC" + ".." + "c....CC",
  "dd......CC.cc" + ".." + "cc...cc",
  "dd.......CCcc" + ".." + ".cccccc",
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
    const cells = resolveRow(GRID[y] ?? "", GRID[y + 1] ?? "")
    let line = ""
    let at = 0
    while (at < cells.length) {
      const ink = cells[at]!.ink
      let end = at
      let glyphs = ""
      while (end < cells.length && sameOrBothNull(cells[end]!.ink, ink)) {
        glyphs += cells[end]!.glyph
        end += 1
      }
      line += ink === null || depth === "plain" ? glyphs : `${foreground(ink, depth)}${glyphs}${RESET}`
      at = end
    }
    rows.push(line)
  }
  return rows
}

interface Cell {
  glyph: string
  /** `null` where nothing is drawn, which is a space and never painted. */
  ink: RGB | null
}

/**
 * One terminal row's cells, from the two pixel rows it carries.
 *
 * The glyph is decided by which halves are *inked* and nothing else, so the
 * plain drawing is the coloured drawing with the paint left off rather than a
 * second drawing that could drift from it.
 *
 * A cell whose halves carry two different inks takes the upper one for both.
 * The alternative — `\u2580` over a background of the lower ink — is right in
 * colour and wrong once stripped, where it would draw a half-empty cell in the
 * middle of a solid stroke. `GRID` is drawn so this never arises, and
 * `logoInkIsRowConstant` holds it to that; if an edit gets past it, losing a
 * shade is the better failure.
 */
function resolveRow(top: string, bottom: string): Cell[] {
  const cells: Cell[] = []
  for (let x = 0; x < LOGO_COLUMNS; x += 1) {
    const above = PALETTE[top[x] ?? "."] ?? null
    const below = PALETTE[bottom[x] ?? "."] ?? null
    if (above === null && below === null) cells.push({ glyph: " ", ink: null })
    else if (above !== null && below !== null) cells.push({ glyph: FULL, ink: above })
    else if (above !== null) cells.push({ glyph: UPPER, ink: above })
    else cells.push({ glyph: LOWER, ink: below })
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

/**
 * Whether every cell of the mark is a single ink, top and bottom.
 *
 * Exported for the test that holds the invariant `span` relies on: shading
 * that straddles a cell boundary is a drawing mistake, and this is how an edit
 * to `GRID` finds out.
 */
export function logoInkIsRowConstant(): boolean {
  for (let y = 0; y < GRID.length; y += 2) {
    const top = GRID[y] ?? ""
    const bottom = GRID[y + 1] ?? ""
    for (let x = 0; x < LOGO_COLUMNS; x += 1) {
      const above = PALETTE[top[x] ?? "."] ?? null
      const below = PALETTE[bottom[x] ?? "."] ?? null
      if (above !== null && below !== null && !sameInk(above, below)) return false
    }
  }
  return true
}

/**
 * The mark at each depth, drawn once.
 *
 * There are only three answers and they never change, so the alternative is
 * rebuilding the same eighteen-by-eight bitmap on every repaint.
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
 * Every screen that opens with the wordmark does the same thing with it — four
 * rows of pixels, up to four lines of already-styled text to their right — and
 * two copies of that arithmetic drift apart the moment one of them grows a
 * line. Lines are taken styled rather than as plain strings so the caller
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

/**
 * Colour for the config UI, drawn from the Forgeline palette.
 *
 * The renderer used to refuse colour outright: every distinction was drawn in
 * words and a gutter `>`, so `NO_COLOR` was honoured by construction. That
 * read fine in a test but made the UI flatter than it needed to be — status,
 * warnings and the cursor all competed in one undifferentiated column of
 * text. The redesign keeps the old guarantee where it matters (plain output
 * for pipes and tests) and adds colour as an overlay the caller opts into:
 *
 *  - `render(state, viewport)` still emits no ANSI unless the viewport hands
 *    it a theme, so existing assertions keep reading plain text.
 *  - The shell decides once, per run, how much colour the terminal can take:
 *    24-bit when `COLORTERM` says so, the nearest xterm-256 slot otherwise,
 *    nothing at all without a TTY, under `NO_COLOR`, or on `TERM=dumb`.
 *
 * Palette roles come straight from `.scratch/forgeline-palette.html`; deep-space
 * indigo foundations carry electric violet and ion cyan accents. The two
 * background entries (`Midnight Forge`, `Royal Indigo`) are deliberately not
 * painted — a TUI that fills the screen repaints the user's own terminal
 * theme, and foreground colour alone carries every distinction here.
 */

/** How much colour the terminal accepts. */
export type ColorMode = "plain" | "256" | "truecolor"

/**
 * Decides the colour mode once per run.
 *
 * Precedence follows the ecosystem conventions a user already knows:
 * `NO_COLOR` wins outright; an explicit `FORCE_COLOR` overrides the TTY check;
 * otherwise colour needs a TTY and a terminal that is not `dumb`.
 */
export function colorSupport(env: NodeJS.ProcessEnv, tty: boolean): ColorMode {
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return "plain"
  if (env["FORCE_COLOR"] !== undefined) {
    if (forceOff(env["FORCE_COLOR"])) return "plain"
    return truecolorCapable(env) ? "truecolor" : "256"
  }
  if (!tty || env["TERM"] === "dumb") return "plain"
  return truecolorCapable(env) ? "truecolor" : "256"
}

function forceOff(value: string): boolean {
  return value === "" || value === "0" || value === "false"
}

function truecolorCapable(env: NodeJS.ProcessEnv): boolean {
  const colorTerm = env["COLORTERM"]
  if (colorTerm === "truecolor" || colorTerm === "24bit") return true
  return /\b(truecolor|direct|24bit)\b/.test(env["TERM"] ?? "")
}

export interface Theme {
  /** Titles and section labels. Electric Violet, bold. */
  heading(text: string): string
  /** The row under the cursor. Cobalt Pulse, bold. */
  focus(text: string): string
  /** Key names in the hint bar, the cursor marker, the armed effort. Ion Cyan. */
  accent(text: string): string
  /** Seat control on, a save that worked, a config in force. Emerald Volt. */
  good(text: string): string
  /** Unsaved changes and warnings. Solar Amber. */
  warn(text: string): string
  /** Errors and seats diagnoseSeats has failed. Magenta Surge. */
  alert(text: string): string
  /** Descriptions, rules, everything secondary. Platinum Mist, dimmed. */
  dim(text: string): string
}

/** The identity theme: every style returns its input unchanged. */
export const PLAIN_THEME: Theme = {
  heading: (text) => text,
  focus: (text) => text,
  accent: (text) => text,
  good: (text) => text,
  warn: (text) => text,
  alert: (text) => text,
  dim: (text) => text,
}

interface Swatch {
  name: string
  hex: [number, number, number]
  /** Nearest slot in the xterm-256 cube, computed by squared distance. */
  xterm: number
}

/**
 * Forgeline palette, foreground roles only.
 *
 * The xterm slots are approximations chosen by eye against the cube levels
 * `[0,95,135,175,215,255]`; a 256-colour terminal cannot hit these hexes
 * exactly and honesty about the nearest neighbour beats pretending.
 */
const SWATCHES = {
  /** Primary · Brand — CTAs & identity. */
  violet: { name: "Electric Violet", hex: [108, 36, 228], xterm: 56 },
  /** Interactive — links & focus. */
  cobalt: { name: "Cobalt Pulse", hex: [40, 80, 200], xterm: 26 },
  /** Highlight — key data points. */
  cyan: { name: "Ion Cyan", hex: [0, 228, 248], xterm: 45 },
  /** Energy — alerts & emphasis. */
  magenta: { name: "Magenta Surge", hex: [248, 42, 168], xterm: 199 },
  /** Strength — ratings & rewards. */
  amber: { name: "Solar Amber", hex: [248, 180, 60], xterm: 215 },
  /** Success · positive status. */
  volt: { name: "Emerald Volt", hex: [20, 184, 48], xterm: 35 },
  /** Text on dark. */
  platinum: { name: "Platinum Mist", hex: [233, 233, 242], xterm: 255 },
} satisfies Record<string, Swatch>

const RESET = "\u001B[0m"

function trueStyle(swatch: Swatch, ...attributes: string[]): (text: string) => string {
  const prefix = `${attributes.join("")}\u001B[38;2;${swatch.hex[0]};${swatch.hex[1]};${swatch.hex[2]}m`
  return (text) => `${prefix}${text}${RESET}`
}

function indexedStyle(swatch: Swatch, ...attributes: string[]): (text: string) => string {
  const prefix = `${attributes.join("")}\u001B[38;5;${swatch.xterm}m`
  return (text) => `${prefix}${text}${RESET}`
}

const BOLD = "\u001B[1m"
const DIM = "\u001B[2m"

/**
 * Builds the theme for what the terminal can draw.
 *
 * `dim` is the SGR faint attribute everywhere colour exists: Platinum Mist is
 * the palette's text colour, and "secondary" is a brightness step, not a hue
 * swap. On a 256-colour terminal every swatch lands on its nearest cube
 * neighbour, documented above rather than hidden.
 */
export function buildTheme(mode: ColorMode): Theme {
  if (mode === "plain") return PLAIN_THEME
  const style = mode === "truecolor" ? trueStyle : indexedStyle
  return {
    heading: style(SWATCHES.violet, BOLD),
    focus: style(SWATCHES.cobalt, BOLD),
    accent: style(SWATCHES.cyan),
    good: style(SWATCHES.volt),
    warn: style(SWATCHES.amber),
    alert: style(SWATCHES.magenta),
    dim: style(SWATCHES.platinum, DIM),
  }
}

/** Matches SGR sequences only; any other escape code stays measurable noise. */
const SGR = /\u001B\[[0-9;]*m/g
const HAS_SGR = /\u001B\[[0-9;]*m/

/** Width of `text` as the terminal will draw it, ignoring colour codes. */
export function visibleLength(text: string): number {
  return text.replace(SGR, "").length
}

/**
 * Pads to `width` measured on visible characters, with the one-space gap the
 * rest of the CLI uses when a value has outgrown its column.
 *
 * Cells are padded before they are styled, so alignment does not depend on
 * colour being on; measuring visibly keeps that true for anything that pads
 * afterwards anyway.
 */
export function padEnd(text: string, width: number): string {
  const visible = visibleLength(text)
  if (visible >= width) return `${text} `
  return text + " ".repeat(width - visible)
}

/**
 * Clips to `width` visible characters without cutting a colour code in half.
 *
 * Escape sequences are atomic: slicing the raw string could leave half an SGR
 * behind and paint everything after it. Styled text is therefore walked one
 * character at a time, codes copied verbatim, printable characters counted;
 * anything clipped mid-style gets an explicit reset so the colour stops where
 * the text does.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return ""
  if (!HAS_SGR.test(text)) return clipPlain(text, width)
  // Styled text that already fits is returned untouched: walking it would
  // only append a reset the styles have each already emitted.
  if (visibleLength(text) <= width) return text
  let kept = ""
  let visible = 0
  let position = 0
  while (position < text.length && visible < width) {
    SGR.lastIndex = position
    const match = SGR.exec(text)
    if (match !== null && match.index === position) {
      kept += match[0]
      position += match[0].length
      continue
    }
    kept += text[position]!
    visible++
    position++
  }
  return `${kept}${RESET}`
}

function clipPlain(text: string, width: number): string {
  if (text.length <= width) return text
  return width >= 8 ? `${text.slice(0, width - 3)}...` : text.slice(0, width)
}

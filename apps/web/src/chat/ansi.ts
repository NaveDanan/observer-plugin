export interface AnsiSegment {
  text: string
  foreground?: string
  background?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
}

interface AnsiState extends Omit<AnsiSegment, "text"> {
  inverse?: boolean
}

const ANSI_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]|\u001B[@-_]/g

const STANDARD_COLORS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
] as const

const BRIGHT_COLORS = [
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
] as const

/** Splits terminal output into styled lines while carrying SGR state between them. */
export function parseAnsiLines(text: string): AnsiSegment[][] {
  const lines: AnsiSegment[][] = [[]]
  const state: AnsiState = {}
  let cursor = 0

  for (const match of text.matchAll(ANSI_PATTERN)) {
    appendText(lines, text.slice(cursor, match.index), state)
    applyEscape(match[0], state)
    cursor = (match.index ?? 0) + match[0].length
  }
  appendText(lines, text.slice(cursor), state)
  return lines
}

function appendText(lines: AnsiSegment[][], text: string, state: AnsiState): void {
  const chunks = text.split("\n")
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? ""
    if (chunk.length > 0) appendSegment(lines[lines.length - 1], segment(chunk, state))
    if (index < chunks.length - 1) lines.push([])
  }
}

function appendSegment(line: AnsiSegment[] | undefined, next: AnsiSegment): void {
  if (!line) return
  const previous = line[line.length - 1]
  if (previous && sameStyle(previous, next)) previous.text += next.text
  else line.push(next)
}

function sameStyle(left: AnsiSegment, right: AnsiSegment): boolean {
  return (
    left.foreground === right.foreground &&
    left.background === right.background &&
    left.bold === right.bold &&
    left.dim === right.dim &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.strike === right.strike
  )
}

function segment(text: string, state: AnsiState): AnsiSegment {
  const foreground = state.inverse ? (state.background ?? "var(--terminal-background)") : state.foreground
  const background = state.inverse ? (state.foreground ?? "var(--terminal-foreground)") : state.background
  return {
    text,
    ...(foreground ? { foreground } : {}),
    ...(background ? { background } : {}),
    ...(state.bold ? { bold: true } : {}),
    ...(state.dim ? { dim: true } : {}),
    ...(state.italic ? { italic: true } : {}),
    ...(state.underline ? { underline: true } : {}),
    ...(state.strike ? { strike: true } : {}),
  }
}

function applyEscape(sequence: string, state: AnsiState): void {
  if (!sequence.startsWith("\u001B[") || !sequence.endsWith("m")) return
  const raw = sequence.slice(2, -1)
  const codes = raw.length === 0 ? [0] : raw.split(";").map((part) => Number(part || 0))

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0
    if (code === 0) reset(state)
    else if (code === 1) state.bold = true
    else if (code === 2) state.dim = true
    else if (code === 3) state.italic = true
    else if (code === 4 || code === 21) state.underline = true
    else if (code === 7) state.inverse = true
    else if (code === 9) state.strike = true
    else if (code === 22) {
      delete state.bold
      delete state.dim
    } else if (code === 23) delete state.italic
    else if (code === 24) delete state.underline
    else if (code === 27) delete state.inverse
    else if (code === 29) delete state.strike
    else if (code >= 30 && code <= 37) state.foreground = STANDARD_COLORS[code - 30]
    else if (code === 38 || code === 48) {
      const parsed = extendedColor(codes, index + 1)
      if (parsed) {
        if (code === 38) state.foreground = parsed.color
        else state.background = parsed.color
        index += parsed.consumed
      }
    } else if (code === 39) delete state.foreground
    else if (code >= 40 && code <= 47) state.background = STANDARD_COLORS[code - 40]
    else if (code === 49) delete state.background
    else if (code >= 90 && code <= 97) state.foreground = BRIGHT_COLORS[code - 90]
    else if (code >= 100 && code <= 107) state.background = BRIGHT_COLORS[code - 100]
  }
}

function extendedColor(codes: number[], start: number): { color: string; consumed: number } | null {
  const mode = codes[start]
  if (mode === 5 && codes[start + 1] !== undefined) {
    return { color: xtermColor(codes[start + 1] ?? 0), consumed: 2 }
  }
  if (mode === 2 && codes[start + 3] !== undefined) {
    const red = channel(codes[start + 1] ?? 0)
    const green = channel(codes[start + 2] ?? 0)
    const blue = channel(codes[start + 3] ?? 0)
    return { color: `rgb(${red} ${green} ${blue})`, consumed: 4 }
  }
  return null
}

function xtermColor(value: number): string {
  const index = Math.max(0, Math.min(255, Math.round(value)))
  if (index < 8) return STANDARD_COLORS[index] ?? STANDARD_COLORS[0]
  if (index < 16) return BRIGHT_COLORS[index - 8] ?? BRIGHT_COLORS[0]
  if (index >= 232) {
    const level = 8 + (index - 232) * 10
    return `rgb(${level} ${level} ${level})`
  }
  const cube = index - 16
  const levels = [0, 95, 135, 175, 215, 255]
  const red = levels[Math.floor(cube / 36)] ?? 0
  const green = levels[Math.floor((cube % 36) / 6)] ?? 0
  const blue = levels[cube % 6] ?? 0
  return `rgb(${red} ${green} ${blue})`
}

function channel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function reset(state: AnsiState): void {
  for (const key of Object.keys(state) as Array<keyof AnsiState>) delete state[key]
}

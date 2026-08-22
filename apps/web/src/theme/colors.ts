/**
 * Colour maths for the theme engine.
 *
 * T3 Code reaches for `culori` here; Observer does the same arithmetic by
 * hand, because the four things the theme system actually needs — canonicalise
 * a literal colour, convert to hex for `<input type="color">`, measure
 * contrast, and derive a palette from two seeds — are a couple of hundred
 * lines of well-specified conversion, and a 40 kB colour library would be the
 * largest dependency in the app.
 *
 * Everything canonicalises to OKLCH, the form theme files are stored in, so a
 * palette round-trips through export/import without drifting.
 */

export interface Oklch {
  L: number
  C: number
  h: number
}

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface ParsedColor {
  color: Oklch
  alpha: number
}

/* ----------------------------------------------------------------- parsing */

const HEX = /^#([0-9a-f]{3,8})$/i
const FUNCTIONAL = /^(rgba?|hsla?|oklch)\(([^)]*)\)$/i

/**
 * Parses a literal CSS colour into OKLCH.
 *
 * Deliberately narrow: hex, `rgb()`, `hsl()` and `oklch()` in both the legacy
 * comma syntax and the modern space syntax. Named colours and `color()` are
 * not accepted — a theme file that carries one gets a clear error at import
 * rather than a silently wrong pixel.
 */
export function parseColor(value: unknown): ParsedColor | null {
  if (typeof value !== "string") return null
  const input = value.trim()
  if (input.length === 0) return null

  const hex = HEX.exec(input)
  if (hex) return parseHex(hex[1] as string)

  const functional = FUNCTIONAL.exec(input)
  if (!functional) return null
  const kind = (functional[1] as string).toLowerCase()
  // `/` separates alpha in modern syntax; commas in the legacy one. Both
  // collapse to the same token list.
  const parts = (functional[2] as string)
    .replace(/\//g, " ")
    .split(/[\s,]+/)
    .filter(Boolean)
  if (parts.length < 3) return null

  const alphaToken = parts[3]
  const alpha = alphaToken === undefined ? 1 : parseAlpha(alphaToken)
  if (alpha === null) return null

  if (kind === "oklch") {
    const L = parseNumber(parts[0] as string, 1)
    const C = parseNumber(parts[1] as string, 1)
    const h = parseNumber(parts[2] as string, 360)
    if (L === null || C === null || h === null) return null
    return { color: { L: clamp(L, 0, 1), C: Math.max(0, C), h }, alpha }
  }

  if (kind === "rgb" || kind === "rgba") {
    const channels = parts.slice(0, 3).map((part) => parseNumber(part, 255))
    if (channels.some((channel) => channel === null)) return null
    const [r, g, b] = channels as number[]
    return { color: rgbToOklch({ r: clamp(r as number, 0, 255), g: clamp(g as number, 0, 255), b: clamp(b as number, 0, 255) }), alpha }
  }

  const h = parseNumber(parts[0] as string, 360)
  const s = parseNumber(parts[1] as string, 1)
  const l = parseNumber(parts[2] as string, 1)
  if (h === null || s === null || l === null) return null
  return { color: rgbToOklch(hslToRgb({ h, s: clamp(s, 0, 1), l: clamp(l, 0, 1) })), alpha }
}

function parseHex(digits: string): ParsedColor | null {
  const expand = (pair: string): number => Number.parseInt(pair.length === 1 ? pair + pair : pair, 16)
  const size = digits.length
  if (size !== 3 && size !== 4 && size !== 6 && size !== 8) return null
  const step = size <= 4 ? 1 : 2
  const channel = (index: number): number => expand(digits.slice(index * step, index * step + step))
  const alpha = size === 4 || size === 8 ? channel(3) / 255 : 1
  return { color: rgbToOklch({ r: channel(0), g: channel(1), b: channel(2) }), alpha }
}

/** A percentage resolves against `scale`; a bare number is taken as-is. */
function parseNumber(token: string, scale: number): number | null {
  if (token === "none") return 0
  if (token.endsWith("%")) {
    const percent = Number.parseFloat(token.slice(0, -1))
    return Number.isFinite(percent) ? (percent / 100) * scale : null
  }
  const value = Number.parseFloat(token)
  return Number.isFinite(value) ? value : null
}

function parseAlpha(token: string): number | null {
  const value = parseNumber(token, 1)
  return value === null ? null : clamp(value, 0, 1)
}

/* --------------------------------------------------------------- formatting */

function trimNumber(value: number, precision: number): string {
  const rounded = Math.abs(value) < 10 ** -precision / 2 ? 0 : value
  return rounded.toFixed(precision).replace(/(?:\.0+|(\.\d*?)0+)$/, "$1")
}

export function formatOklch(color: Oklch, alpha = 1): string {
  const hue = color.C < 0.0000005 ? 0 : ((color.h % 360) + 360) % 360
  const body = `${trimNumber(color.L, 6)} ${trimNumber(color.C, 6)} ${trimNumber(hue, 3)}`
  return alpha < 1 ? `oklch(${body} / ${trimNumber(alpha, 4)})` : `oklch(${body})`
}

/** The canonical storage form for a theme colour, or null when unparseable. */
export function toCanonicalColor(value: unknown): string | null {
  const parsed = parseColor(value)
  return parsed ? formatOklch(parsed.color, parsed.alpha) : null
}

export function isThemeColor(value: unknown): value is string {
  return toCanonicalColor(value) !== null
}

/** Hex for the colour inputs, with an alpha pair only when it is not opaque. */
export function toHex(value: string): string | null {
  const parsed = parseColor(value)
  if (!parsed) return null
  const opaque = rgbToHex(oklchToRgb(parsed.color))
  if (parsed.alpha >= 1) return opaque
  return `${opaque}${Math.round(parsed.alpha * 255).toString(16).padStart(2, "0")}`
}

export function rgbToHex(color: Rgb): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0"))
    .join("")}`
}

export function rgbToColor(color: Rgb): string {
  return formatOklch(rgbToOklch(color))
}

export function colorToRgb(value: string, fallback: Rgb): Rgb {
  const parsed = parseColor(value)
  return parsed ? oklchToRgb(parsed.color) : fallback
}

/* -------------------------------------------------------------- conversion */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function srgbToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(channel: number): number {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
  return Math.round(clamp(c, 0, 1) * 255)
}

export function rgbToOklch(color: Rgb): Oklch {
  const r = srgbToLinear(color.r)
  const g = srgbToLinear(color.g)
  const b = srgbToLinear(color.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI }
}

function oklchToLinear({ L, C, h }: Oklch): { r: number; g: number; b: number } {
  const hr = (h * Math.PI) / 180
  const a = C * Math.cos(hr)
  const bb = C * Math.sin(hr)
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  }
}

/** The greatest chroma at the same lightness and hue that still fits sRGB. */
export function mapToSrgbGamut(color: Oklch): Oklch {
  const inGamut = (C: number): boolean => {
    const linear = oklchToLinear({ ...color, C })
    return [linear.r, linear.g, linear.b].every((channel) => channel >= -0.0001 && channel <= 1.0001)
  }
  if (inGamut(color.C)) return color

  let low = 0
  let high = color.C
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2
    if (inGamut(mid)) low = mid
    else high = mid
  }
  return { ...color, C: low }
}

export function oklchToRgb(color: Oklch): Rgb {
  const linear = oklchToLinear(mapToSrgbGamut(color))
  return { r: linearToSrgb(linear.r), g: linearToSrgb(linear.g), b: linearToSrgb(linear.b) }
}

export function oklchToColor(color: Oklch): string {
  return formatOklch(mapToSrgbGamut(color))
}

export function hslToRgb(color: { h: number; s: number; l: number }): Rgb {
  const hue = ((color.h % 360) + 360) % 360
  const chroma = (1 - Math.abs(2 * color.l - 1)) * color.s
  const sector = hue / 60
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1))
  const match = color.l - chroma / 2
  const [r, g, b] =
    sector < 1
      ? [chroma, secondary, 0]
      : sector < 2
        ? [secondary, chroma, 0]
        : sector < 3
          ? [0, chroma, secondary]
          : sector < 4
            ? [0, secondary, chroma]
            : sector < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary]
  return { r: ((r as number) + match) * 255, g: ((g as number) + match) * 255, b: ((b as number) + match) * 255 }
}

export function rgbToHsl(color: Rgb): { h: number; s: number; l: number } {
  const red = color.r / 255
  const green = color.g / 255
  const blue = color.b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  const lightness = (max + min) / 2
  if (delta === 0) return { h: 0, s: 0, l: lightness }

  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  let hue = 0
  if (max === red) hue = ((green - blue) / delta) % 6
  else if (max === green) hue = (blue - red) / delta + 2
  else hue = (red - green) / delta + 4
  return { h: (hue * 60 + 360) % 360, s: saturation, l: lightness }
}

/* --------------------------------------------------------------- contrast */

export function mixRgb(base: Rgb, overlay: Rgb, amount: number): Rgb {
  return {
    r: base.r + (overlay.r - base.r) * amount,
    g: base.g + (overlay.g - base.g) * amount,
    b: base.b + (overlay.b - base.b) * amount,
  }
}

export function relativeLuminance(color: Rgb): number {
  const linearize = (channel: number): number => {
    const normalized = channel / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b)
}

export function contrastRatio(first: Rgb, second: Rgb): number {
  const a = relativeLuminance(first)
  const b = relativeLuminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * The relative luminance at which white and black text have equal headroom.
 * Anything below it is treated as a dark surface, whatever the theme calls
 * itself — a dark canvas saved as a "light" theme still needs light text.
 */
export const DARK_SURFACE_LUMINANCE = 0.179

export function isDarkSurface(color: Rgb): boolean {
  return relativeLuminance(color) < DARK_SURFACE_LUMINANCE
}

const LIGHT_FOREGROUND: Rgb = { r: 255, g: 250, b: 255 }
const DARK_FOREGROUND: Rgb = { r: 36, g: 21, b: 35 }
const WHITE: Rgb = { r: 255, g: 255, b: 255 }
const BLACK: Rgb = { r: 0, g: 0, b: 0 }

export function readableForeground(background: Rgb): Rgb {
  const light = contrastRatio(background, LIGHT_FOREGROUND)
  const dark = contrastRatio(background, DARK_FOREGROUND)
  if (Math.max(light, dark) >= 4.5) return light >= dark ? LIGHT_FOREGROUND : DARK_FOREGROUND
  return contrastRatio(background, WHITE) >= contrastRatio(background, BLACK) ? WHITE : BLACK
}

/** Binary-searches the lightness that clears `minContrast` against a surface. */
export function solveLightness(
  base: Oklch,
  against: Rgb,
  minContrast: number,
  direction: "lighter" | "darker",
): Oklch {
  let low = direction === "lighter" ? base.L : 0
  let high = direction === "lighter" ? 1 : base.L
  let candidate = { ...base }
  if (contrastRatio(oklchToRgb(candidate), against) >= minContrast) return candidate
  for (let step = 0; step < 18; step += 1) {
    const mid = (low + high) / 2
    candidate = { ...base, L: mid }
    if (contrastRatio(oklchToRgb(candidate), against) >= minContrast) {
      if (direction === "lighter") high = mid
      else low = mid
    } else {
      if (direction === "lighter") low = mid
      else high = mid
    }
  }
  return { ...base, L: direction === "lighter" ? high : low }
}

/**
 * Softens a foreground toward its background as far as the contrast floor
 * allows. Returning the full-strength foreground when the requested mix falls
 * short would make secondary labels snap from slightly dim to fully bright.
 */
export function readableText(background: Rgb, foreground: Rgb, amount: number, minimum: number): Rgb {
  const softened = mixRgb(foreground, background, amount)
  if (contrastRatio(softened, background) >= minimum) return softened

  let readable = foreground
  let low = 0
  let high = amount
  for (let index = 0; index < 12; index += 1) {
    const mid = (low + high) / 2
    const candidate = mixRgb(foreground, background, mid)
    if (contrastRatio(candidate, background) >= minimum) {
      readable = candidate
      low = mid
    } else {
      high = mid
    }
  }
  return readable
}

/**
 * Measured contrast of the stock muted text on the stock canvases. Generated
 * palettes match this perceived strength rather than picking a mix by feel.
 */
const LIGHT_MUTED_CONTRAST = 4.705
const DARK_MUTED_CONTRAST = 5.082

export function mutedText(background: Rgb, foreground: Rgb): Rgb {
  return readableText(background, foreground, 1, isDarkSurface(background) ? DARK_MUTED_CONTRAST : LIGHT_MUTED_CONTRAST)
}

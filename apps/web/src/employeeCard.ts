/**
 * The NJ-LABS employee ID card: geometry and derived fields.
 *
 * Everything on the card is a fraction of the template PNG's own 1023x1537
 * pixel box, so this module is written in native template pixels and divides
 * through exactly once, in `cardCssVariables`. The reference implementation
 * this is ported from (`tech_company_roster/`) held the same numbers in three
 * places — `PHOTO_ZOOM` in app.js, percentages in style.css, and a second set
 * of rects in the canvas exporter — and they had drifted apart: the exported
 * pill text came out ~32% smaller than the preview, letter-spacing was lost,
 * and the two auto-shrink paths measured different strings against different
 * thresholds. There is one renderer here and one constant behind it.
 *
 * No DOM, no React. Every rule the card encodes is a pure function, because
 * `apps/web` tests run in a node environment.
 */

import type { RosterProfile } from "@observer-ai/roster"

/**
 * The card, in template pixels.
 *
 * Rects were resolved from the reference stylesheet against the template's
 * real 1023x1537 raster. The pill rows carry text only: the purple pill
 * shapes and their ROLE / DEPARTMENT / EMPLOYEE ID / ACCESS LEVEL captions
 * are painted into the PNG, so nothing here re-draws them.
 */
export const CARD_LAYOUT = {
  /** The template raster's own size. Every other number divides by these. */
  width: 1023,
  height: 1537,
  /**
   * Served from the daemon root like the roster photos. The misspelling is
   * the artifact's real filename and is preserved so the asset stays
   * greppable against `tech_company_roster/`.
   */
  templateUrl: "/card/emploee-card.png",

  /** The card's own corner radius, taken from the reference stylesheet. */
  cardRadius: 44,

  /** The window cut into the template artwork for the portrait. */
  photo: { x: 112, y: 486, width: 418, height: 574, radius: 14 },
  /**
   * Portrait scale, as a fraction of `cover`.
   *
   * Roster portraits are square (1254x1254) and the frame is portrait
   * (418x574). Plain `cover` scales the source to 574 and crops ~27% off
   * each side, which cuts away the side artwork every portrait is composed
   * around. At 0.80 of cover the image lands at 459x459, only ~5% is
   * trimmed per side, and it is pinned to the frame bottom so the subject
   * sits on the edge instead of floating. The ~115px left at the top is
   * filled by a gradient sampled from the portrait's own top row.
   */
  photoZoom: 0.8,
  /** Intrinsic size of every roster portrait. */
  portrait: { width: 1254, height: 1254 },

  /** The headline name, left-aligned above the thin rule at y=611. */
  name: { x: 590, y: 505, width: 337, fontSize: 52, minFontSize: 30, lineHeight: 0.95, letterSpacing: -0.03 },

  /** The four value rows. `x`, `width` and `height` are shared; only `y` differs. */
  pill: { x: 652, width: 267, height: 42, fontSize: 22, minFontSize: 12, paddingX: 12, letterSpacing: 0.02 },
  /**
   * Row tops, re-measured against the template raster rather than inherited.
   *
   * The reference put rows 3 and 4 at 914 and 1031. Sampling the PNG's own
   * luminance step at five x positions across each row puts their centres at
   * 939 and 1057, not 935 and 1052 — so both were riding 4-5px high, a fifth
   * of the type size. Rows 1 and 2 measure exactly where the reference said,
   * which is what says the measurement is sound rather than the method being
   * off by a constant. See docs/adr/0003-employee-card-carve-out.md.
   */
  pillRows: { role: 678, department: 801, employeeId: 918, accessLevel: 1036 },
} as const

/** The four rows, in the order they appear on the card. */
export const PILL_ROWS = ["role", "department", "employeeId", "accessLevel"] as const
export type PillRow = (typeof PILL_ROWS)[number]

// --------------------------------------------------------------- geometry

/**
 * The portrait's rendered box inside the photo frame, in template pixels.
 *
 * This is the single expression of `photoZoom`. The CSS percentages the
 * reference hardcoded next to it are produced from this, not alongside it.
 */
export function photoImageBox(): { width: number; height: number } {
  const { photo, photoZoom, portrait } = CARD_LAYOUT
  const cover = Math.max(photo.width / portrait.width, photo.height / portrait.height)
  const scale = cover * photoZoom
  return { width: portrait.width * scale, height: portrait.height * scale }
}

function pct(value: number, total: number): string {
  // Six decimals is ~0.001px at the card's largest rendered width.
  return `${((value / total) * 100).toFixed(6)}%`
}

function ratio(value: number): string {
  return (value / CARD_LAYOUT.width).toFixed(6)
}

/**
 * The whole layout as CSS custom properties, set on the card element.
 *
 * Positions are percentages of the card box. Lengths that must scale with
 * type — radii, padding, font sizes — are unitless ratios of the card's
 * width, multiplied by `--nj-card-w` in the stylesheet. That keeps
 * `styles.css` free of card geometry: it reads variables, it does not
 * restate numbers.
 */
export function cardCssVariables(): Record<string, string> {
  const { width, height, photo, name, pill, pillRows } = CARD_LAYOUT
  const image = photoImageBox()
  return {
    // 1023/1537, used to solve the card's width from the viewport height.
    "--nj-aspect": (width / height).toFixed(6),
    "--nj-card-radius": ratio(CARD_LAYOUT.cardRadius),
    "--nj-photo-left": pct(photo.x, width),
    "--nj-photo-top": pct(photo.y, height),
    "--nj-photo-width": pct(photo.width, width),
    "--nj-photo-height": pct(photo.height, height),
    "--nj-photo-radius": ratio(photo.radius),
    // Relative to the frame, not the card: this is an `object-fit` box.
    "--nj-photo-img-width": pct(image.width, photo.width),
    "--nj-photo-img-height": pct(image.height, photo.height),
    "--nj-name-left": pct(name.x, width),
    "--nj-name-top": pct(name.y, height),
    "--nj-name-width": pct(name.width, width),
    "--nj-name-line-height": String(name.lineHeight),
    "--nj-pill-left": pct(pill.x, width),
    "--nj-pill-width": pct(pill.width, width),
    "--nj-pill-height": pct(pill.height, height),
    // The pill centres its text with a line box, which is what makes
    // `text-overflow: ellipsis` work; a flex centre would defeat it.
    "--nj-pill-line": ratio(pill.height),
    "--nj-pill-letter-spacing": `${pill.letterSpacing}em`,
    "--nj-name-letter-spacing": `${name.letterSpacing}em`,
    "--nj-pill-padding": ratio(pill.paddingX),
    "--nj-pill-role-top": pct(pillRows.role, height),
    "--nj-pill-department-top": pct(pillRows.department, height),
    "--nj-pill-employeeId-top": pct(pillRows.employeeId, height),
    "--nj-pill-accessLevel-top": pct(pillRows.accessLevel, height),
  }
}

/**
 * A template-pixel font size as a CSS length that tracks the card's width.
 *
 * `--nj-card-w` is the one length the stylesheet owns; everything typographic
 * is a multiple of it, so the card scales as a single unit at any size.
 */
export function scaledFontSize(nativePx: number): string {
  return `calc(var(--nj-card-w) * ${ratio(nativePx)})`
}

// ------------------------------------------------------------ text fitting

/** Measures a string's rendered width, in the same units as `fontSize`. */
export type TextMeasure = (text: string, fontSize: number) => number

/**
 * Per-character advance widths for Inter at weight 800-900, in em.
 *
 * Deliberately a static table rather than a canvas `measureText` call. A
 * canvas measurer is exact but only exists in a browser, races the webfont
 * load, and would reintroduce exactly the two-renderers problem this module
 * exists to kill — the test could no longer verify what the browser draws.
 * The values below are rounded up, so a fitted size is never too large.
 */
const NARROW_ADVANCE: Record<string, number> = {
  " ": 0.26,
  ".": 0.3,
  ",": 0.3,
  ":": 0.3,
  ";": 0.3,
  "'": 0.26,
  "!": 0.34,
  "|": 0.3,
  "-": 0.4,
  "/": 0.42,
  "\u2022": 0.42,
  "(": 0.4,
  ")": 0.4,
  I: 0.32,
  J: 0.5,
  i: 0.28,
  j: 0.28,
  l: 0.28,
  t: 0.4,
  f: 0.38,
  r: 0.45,
  s: 0.52,
  c: 0.55,
  y: 0.55,
  k: 0.55,
  v: 0.55,
  x: 0.55,
  z: 0.52,
}

const WIDE_ADVANCE: Record<string, number> = {
  M: 0.9,
  W: 0.92,
  m: 0.88,
  w: 0.78,
  "&": 0.72,
  "@": 0.95,
}

/** Class defaults for anything not named above. */
const UPPERCASE_ADVANCE = 0.73
const LOWERCASE_ADVANCE = 0.6
const DIGIT_ADVANCE = 0.64
const FALLBACK_ADVANCE = 0.64

export function characterAdvance(character: string): number {
  const wide = WIDE_ADVANCE[character]
  if (wide !== undefined) return wide
  const narrow = NARROW_ADVANCE[character]
  if (narrow !== undefined) return narrow
  if (character >= "0" && character <= "9") return DIGIT_ADVANCE
  if (character >= "A" && character <= "Z") return UPPERCASE_ADVANCE
  if (character >= "a" && character <= "z") return LOWERCASE_ADVANCE
  return FALLBACK_ADVANCE
}

/** Conservative width of `text` set in Inter Black at `fontSize`. */
export const estimateTextWidth: TextMeasure = (text, fontSize) => {
  let em = 0
  for (const character of text) em += characterAdvance(character)
  return em * fontSize
}

export interface FitOptions {
  maxWidth: number
  maxFontSize: number
  minFontSize: number
  /** Tracking in em, matching the `letter-spacing` the stylesheet applies. */
  letterSpacing?: number
  measure?: TextMeasure
}

/**
 * The largest size at or below `maxFontSize` that keeps `text` inside
 * `maxWidth`, in half-pixel steps and never below `minFontSize`.
 *
 * Glyph advances scale linearly with font size, so one measurement solves
 * it: no search loop, and no threshold table keyed off string length like
 * the reference used — which is why its preview and its exporter disagreed
 * about when to shrink. Below `minFontSize` the CSS ellipsis takes over.
 */
export function fitFontSize(text: string, options: FitOptions): number {
  const measure = options.measure ?? estimateTextWidth
  // Tracking is applied per character by the browser and scales with the font
  // size like every advance does, so it folds into the same linear solve.
  // Leaving it out is why the reference's exported pills ran wider than it
  // measured them.
  const tracking = (options.letterSpacing ?? 0) * [...text].length
  const width = measure(text, options.maxFontSize) + tracking * options.maxFontSize
  if (width <= options.maxWidth || width === 0) return options.maxFontSize
  const solved = options.maxFontSize * (options.maxWidth / width)
  return Math.max(options.minFontSize, Math.floor(solved * 2) / 2)
}

/** Width available for pill text once the template's own padding is removed. */
export function pillTextWidth(): number {
  return CARD_LAYOUT.pill.width - CARD_LAYOUT.pill.paddingX * 2
}

export function fitPillFontSize(text: string, measure?: TextMeasure): number {
  return fitFontSize(text, {
    maxWidth: pillTextWidth(),
    maxFontSize: CARD_LAYOUT.pill.fontSize,
    minFontSize: CARD_LAYOUT.pill.minFontSize,
    letterSpacing: CARD_LAYOUT.pill.letterSpacing,
    measure,
  })
}

/** Rendered width of a fitted string, tracking included. */
export function trackedTextWidth(text: string, fontSize: number, letterSpacing: number): number {
  return estimateTextWidth(text, fontSize) + [...text].length * letterSpacing * fontSize
}

/** The headline is fitted against its longest line, so both lines match. */
export function fitNameFontSize(lines: readonly string[], measure?: TextMeasure): number {
  const longest = lines.reduce((best, line) => (line.length > best.length ? line : best), "")
  return fitFontSize(longest, {
    maxWidth: CARD_LAYOUT.name.width,
    maxFontSize: CARD_LAYOUT.name.fontSize,
    minFontSize: CARD_LAYOUT.name.minFontSize,
    letterSpacing: CARD_LAYOUT.name.letterSpacing,
    measure,
  })
}

// ------------------------------------------------------------- derivations

/**
 * The department printed on the card.
 *
 * The roster has no department field and does not need one: a department is
 * a view of a title, not a fact about a person, and adding it to
 * `packages/roster` would put two sources of truth in the repo. Ported from
 * `tech_company_roster/app.js:48`, keyed on `title` and `id` instead of that
 * file's nested `role.title`.
 */
export function inferDepartment(profile: RosterProfile): string {
  const title = profile.title.toLowerCase()
  if (profile.id === "leila-haddad" || title.includes("chief technology officer")) return "Executive Leadership"
  if (profile.id === "adrian-cole" || title.includes("chief information security")) return "Security \u2022 Executive"
  if (title.includes("data") || title.includes("analytics")) return "Data"
  if (title.includes("cybersecurity") || title.includes("security")) return "Security"
  if (title.includes("product")) return "Product & Design"
  if (title.includes("program manager") || title.includes("tpm")) return "Program Management"
  if (title.includes("hardware") || title.includes("electronics")) return "Hardware Engineering"
  return "Engineering"
}

/**
 * Titles the card prints verbatim, and their card-length replacements.
 *
 * An ID card sets a role on one 267px line; a full HR title does not fit
 * one. These are the same five the reference hand-wrote, plus a sixth for
 * "Principal Technical Program Manager" — 35 characters, the longest on the
 * roster, which the reference passed through untouched and clipped.
 */
const ROLE_REWRITES: Array<[RegExp, string]> = [
  [/^vice president of (.+) and (.+)$/i, "VP $1 & $2"],
  [/chief technology officer/i, "CTO"],
  [/chief information security officer/i, "CISO"],
  [/principal technical program manager/i, "Principal TPM"],
  [/senior devops and site reliability engineer/i, "Senior DevOps / SRE"],
  [/principal electronics and hardware engineer/i, "Principal Hardware Eng."],
]

/**
 * Generic squeezes, applied in order and only while the title is still too
 * long. Ordered least-lossy first: an ampersand reads as itself, "Eng."
 * reads as a clipped word, "Sr." reads as a different register.
 */
const ROLE_SQUEEZES: Array<[RegExp, string]> = [
  [/ and /gi, " & "],
  [/\bEngineer\b/g, "Eng."],
  [/\bSenior\b/g, "Sr."],
]

/**
 * The longest role the pill sets at full size without the ellipsis showing.
 * Verified against all fourteen employees in `employeeCard.test.ts`.
 */
export const MAX_ROLE_CHARACTERS = 23

/** Ported from `tech_company_roster/app.js:64`, with the squeeze pass added. */
export function shortRoleTitle(title: string): string {
  for (const [pattern, replacement] of ROLE_REWRITES) {
    if (pattern.test(title)) return title.replace(pattern, replacement)
  }
  let short = title
  for (const [pattern, replacement] of ROLE_SQUEEZES) {
    if (short.length <= MAX_ROLE_CHARACTERS) break
    short = short.replace(pattern, replacement)
  }
  return short
}

/**
 * The headline name, split across at most two lines.
 *
 * The honorific is dropped: the card sets a name at 52px in a 337px box and
 * "Dr." costs a fifth of the first line to say nothing the title does not.
 * Ported from `tech_company_roster/app.js:75`.
 */
export function formatDisplayName(fullName: string): string[] {
  const stripped = fullName.replace(/^Dr\.?\s+/i, "").trim()
  const parts = stripped.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return [""]
  if (parts.length <= 2) return parts
  return [parts.slice(0, -1).join(" "), parts[parts.length - 1]!]
}

/**
 * Employee numbers, pinned to the stable `profile.id`.
 *
 * The reference computes `10415 + arrayIndex`. That is fragile in a way an
 * employee number must never be: reordering the roster, or inserting anyone
 * above the last entry, silently reissues everybody else's ID. The numbers
 * below are the ones that scheme produced for the roster as it stands, so
 * nothing visible changes today, but they are now facts about a person
 * rather than a position in an array.
 */
const EMPLOYEE_NUMBERS: Record<string, number> = {
  "arjun-mehta": 10415,
  "malik-johnson": 10416,
  "elias-mercer": 10417,
  "dr-mei-lin": 10418,
  "nia-okafor": 10419,
  "sofia-moreno": 10420,
  "daniel-brooks": 10421,
  "ravi-menon": 10422,
  "leila-haddad": 10423,
  "marcus-reed": 10424,
  "elena-vargas": 10425,
  "omar-rahman": 10426,
  "dr-maya-chen": 10427,
  "adrian-cole": 10428,
}

/**
 * Numbers for ids not in the table, in a band that cannot collide with it.
 *
 * A new employee should not need a manual entry to get a card, and should
 * not be able to take a number already issued, so the hash lands in
 * 10500-10999 while the pinned block stays below 10500.
 */
const HASH_BAND_START = 10500
const HASH_BAND_SIZE = 500

/** FNV-1a, 32-bit. Stable across runs and platforms, which `Math.random` is not. */
function hashId(id: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function employeeNumber(profile: RosterProfile): number {
  return EMPLOYEE_NUMBERS[profile.id] ?? HASH_BAND_START + (hashId(profile.id) % HASH_BAND_SIZE)
}

export function formatEmployeeId(profile: RosterProfile): string {
  return `ID: ${employeeNumber(profile)}`
}

/**
 * Clearance printed on the card: title seniority, nudged by tenure.
 * Ported from `tech_company_roster/app.js:91`.
 */
export function getAccessLevel(profile: RosterProfile): string {
  const title = profile.title.toLowerCase()
  const years = profile.yearsOfExperience
  let level: number
  if (/chief|vice president|\bcto\b|\bciso\b/.test(title)) level = 5
  else if (/principal|staff|lead|director|manager/.test(title)) level = 4
  else if (title.includes("senior")) level = 3
  else level = 2

  if (years >= 15 && level < 5) level = Math.min(5, level + 1)
  else if (years >= 10 && level < 4) level = 4

  return `Level ${level} Access`
}

// ------------------------------------------------------------- card fields

export interface CardField {
  row: PillRow
  /** The caption already painted into the template, for the accessible copy. */
  label: string
  value: string
  /** Fitted size in template pixels. */
  fontSize: number
}

export interface EmployeeCardContent {
  nameLines: string[]
  nameFontSize: number
  fields: CardField[]
}

const PILL_LABELS: Record<PillRow, string> = {
  role: "Role",
  department: "Department",
  employeeId: "Employee ID",
  accessLevel: "Access level",
}

/** Everything the card renders, derived from a profile in one pass. */
export function employeeCardContent(profile: RosterProfile, measure?: TextMeasure): EmployeeCardContent {
  const values: Record<PillRow, string> = {
    role: shortRoleTitle(profile.title),
    department: inferDepartment(profile),
    employeeId: formatEmployeeId(profile),
    accessLevel: getAccessLevel(profile),
  }
  const nameLines = formatDisplayName(profile.fullName)
  return {
    nameLines,
    nameFontSize: fitNameFontSize(nameLines, measure),
    fields: PILL_ROWS.map((row) => ({
      row,
      label: PILL_LABELS[row],
      value: values[row],
      fontSize: fitPillFontSize(values[row], measure),
    })),
  }
}

// -------------------------------------------------------- photo backdrop

/** The card's own navy, used when the portrait cannot be sampled. */
export const PHOTO_BACKDROP_FALLBACK = "#1a1740"

/** Horizontal samples taken across the portrait's top edge. */
export const PHOTO_BACKDROP_STOPS = 5

/**
 * A gradient matching the portrait's own top edge, for the gap that
 * `photoZoom` leaves above a bottom-pinned portrait. Without it the frame
 * shows a hard band where the artwork stops.
 *
 * Takes raw RGBA bytes so the sampling (a canvas call) and the colour maths
 * (this) can be tested apart.
 */
export function photoBackdropGradient(pixels: ArrayLike<number>, stops = PHOTO_BACKDROP_STOPS): string {
  if (stops < 2 || pixels.length < stops * 4) return PHOTO_BACKDROP_FALLBACK
  const parts: string[] = []
  for (let index = 0; index < stops; index++) {
    const offset = index * 4
    const position = ((index / (stops - 1)) * 100).toFixed(0)
    parts.push(`rgb(${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}) ${position}%`)
  }
  return `linear-gradient(90deg, ${parts.join(",")})`
}

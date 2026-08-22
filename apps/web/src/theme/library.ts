/**
 * The theme library: which themes exist, where user themes are kept, and how a
 * two-colour draft becomes a full palette.
 *
 * Storage is `localStorage` and nothing else. A theme is a look, not a
 * setting the daemon has any business knowing about, and keeping it local
 * means the Appearance tab keeps working when the daemon is down.
 */

import {
  BUILT_IN_THEMES,
  T3_CHAT_THEME,
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  T3_CODE_THEME,
  T3_CODE_THEME_ID,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeVariants,
} from "./palettes"
import {
  colorToRgb,
  contrastRatio,
  isDarkSurface,
  isThemeColor,
  mixRgb,
  mutedText,
  oklchToColor,
  readableForeground,
  rgbToColor,
  rgbToHsl,
  hslToRgb,
  solveLightness,
  rgbToOklch,
  oklchToRgb,
  toCanonicalColor,
  type Rgb,
} from "./colors"

export const CUSTOM_THEMES_STORAGE_KEY = "observer:themes:v1"
export const THEME_FILE_VERSION = 1 as const

export type ThemeColorOverrides = Readonly<Partial<Record<ThemeColorRole, string>>>
export type ThemePreference = string
export type ThemePreferenceMode = ThemeAppearance | "system"

export interface ThemeFile {
  version: typeof THEME_FILE_VERSION
  id: string
  name: string
  appearance: ThemeAppearance
  colors: ThemeColors
  variants?: ThemeVariants
}

const THEME_COLOR_ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES)

/** Ids the library owns. A user theme may never take one of them. */
const RESERVED_THEME_IDS = new Set<string>([
  "system",
  "light",
  "dark",
  T3_CODE_THEME_ID,
  ...BUILT_IN_THEMES.map((theme) => theme.id),
])

/* ------------------------------------------------------------- the library */

/** Every theme the picker offers, stock first. */
export function getLibraryThemes(): ReadonlyArray<ThemeDefinition> {
  return [T3_CODE_THEME, ...BUILT_IN_THEMES, ...getCustomThemes()]
}

export function getThemeDefinition(theme: ThemePreference): ThemeDefinition | null {
  if (theme === T3_CODE_THEME_ID) return T3_CODE_THEME
  return (
    BUILT_IN_THEMES.find((definition) => definition.id === theme) ??
    getCustomThemes().find((definition) => definition.id === theme) ??
    null
  )
}

export function getThemeColorsForMode(theme: ThemeDefinition, mode: ThemeAppearance): ThemeColors | null {
  if (mode === theme.appearance) return theme.colors
  return theme.variants?.[mode] ?? null
}

export function getThemeModes(theme: ThemeDefinition): ReadonlyArray<ThemeAppearance> {
  return (["light", "dark"] as const).filter((mode) => getThemeColorsForMode(theme, mode) !== null)
}

export function getThemePreferenceMode(theme: ThemePreference): ThemeAppearance | null {
  if (theme === "system") return null
  if (theme === "light" || theme === "dark") return theme
  return getThemeDefinition(theme)?.appearance ?? null
}

export function isKnownThemePreference(theme: string): boolean {
  if (theme === "light" || theme === "dark" || theme === "system") return true
  return getThemeDefinition(theme) !== null
}

/** Theme-file defaults follow the flagship palette for the requested mode. */
export function getDefaultThemeColors(appearance: ThemeAppearance): ThemeColors {
  return appearance === "dark" ? (T3_CHAT_THEME.variants?.dark as ThemeColors) : T3_CHAT_THEME.colors
}

/** The stock look, for seeding a draft from what the user is already seeing. */
export function getStandardThemeColors(appearance: ThemeAppearance): ThemeColors {
  return appearance === "dark" ? T3_CODE_DARK_THEME_COLORS : T3_CODE_LIGHT_THEME_COLORS
}

/* ------------------------------------------------------- user theme storage */

const listeners = new Set<() => void>()
let cache: ReadonlyArray<ThemeDefinition> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isThemeAppearance(value: unknown): value is ThemeAppearance {
  return value === "light" || value === "dark"
}

function isThemeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{0,47})$/.test(value)
}

function isThemeLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48
}

/**
 * Reads one stored theme, tolerating unknown roles and bad values so a theme
 * written by a newer build keeps the colours this build does understand.
 */
function parseStoredTheme(value: unknown): ThemeDefinition | null {
  if (!isRecord(value)) return null
  if (!isThemeId(value.id) || RESERVED_THEME_IDS.has(value.id)) return null
  if (!isThemeLabel(value.label) || !isThemeAppearance(value.appearance)) return null

  const colors = parseStoredColors(value.colors, value.appearance)
  if (!colors) return null

  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {}
  if (isRecord(value.variants)) {
    for (const [appearance, stored] of Object.entries(value.variants)) {
      if (!isThemeAppearance(appearance) || appearance === value.appearance) continue
      const parsed = parseStoredColors(stored, appearance)
      if (parsed) variants[appearance] = parsed
    }
  }

  return {
    id: value.id,
    label: value.label.trim(),
    appearance: value.appearance,
    colors,
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  }
}

function parseStoredColors(value: unknown, appearance: ThemeAppearance): ThemeColors | null {
  if (!isRecord(value)) return null
  const colors: Partial<Record<ThemeColorRole, string>> = { ...getDefaultThemeColors(appearance) }
  for (const [role, color] of Object.entries(value)) {
    const normalized = toCanonicalColor(color)
    if (THEME_COLOR_ROLE_SET.has(role) && normalized) colors[role as ThemeColorRole] = normalized
  }
  return colors as ThemeColors
}

function readStored(): ReadonlyArray<ThemeDefinition> {
  if (typeof window === "undefined") return []
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const themes: ThemeDefinition[] = []
    for (const entry of parsed) {
      const theme = parseStoredTheme(entry)
      if (theme && !themes.some((existing) => existing.id === theme.id)) themes.push(theme)
    }
    return themes
  } catch {
    return []
  }
}

export function getCustomThemes(): ReadonlyArray<ThemeDefinition> {
  if (cache === null) cache = readStored()
  return cache
}

export function invalidateCustomThemes(): void {
  cache = null
  for (const listener of listeners) listener()
}

export function subscribeToCustomThemes(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function save(themes: ReadonlyArray<ThemeDefinition>): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(themes))
  cache = themes
  for (const listener of listeners) listener()
}

function canonicalise(theme: ThemeDefinition): ThemeDefinition {
  const decode = (colors: ThemeColors): ThemeColors =>
    Object.fromEntries(
      THEME_COLOR_ROLES.map((role) => {
        const color = toCanonicalColor(colors[role])
        if (!color) throw new Error(`The colour for "${role}" must be a literal CSS colour such as oklch(0.62 0.2 280).`)
        return [role, color]
      }),
    ) as ThemeColors

  return {
    ...theme,
    colors: decode(theme.colors),
    ...(theme.variants
      ? {
          variants: Object.fromEntries(
            Object.entries(theme.variants).map(([appearance, colors]) => [appearance, decode(colors)]),
          ) as ThemeVariants,
        }
      : {}),
  }
}

export function installCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id)) throw new Error(`The theme id "${theme.id}" is reserved.`)
  const themes = getCustomThemes()
  if (themes.some((existing) => existing.id === theme.id)) {
    throw new Error(`A theme named "${theme.label}" is already installed.`)
  }
  const canonical = canonicalise(theme)
  save([...themes, canonical])
  return canonical
}

export function updateCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  const themes = getCustomThemes()
  const index = themes.findIndex((existing) => existing.id === theme.id)
  if (index === -1) throw new Error(`The theme "${theme.label}" is not installed.`)
  const canonical = canonicalise(theme)
  const next = [...themes]
  next[index] = canonical
  save(next)
  return canonical
}

export function removeCustomTheme(themeId: string): void {
  const themes = getCustomThemes()
  const next = themes.filter((theme) => theme.id !== themeId)
  if (next.length !== themes.length) save(next)
}

export function themeIdFromName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return normalized || "custom-theme"
}

/** An id that is free right now, so duplicating "Ocean" twice still works. */
export function uniqueThemeId(base: string): string {
  const taken = new Set([...RESERVED_THEME_IDS, ...getCustomThemes().map((theme) => theme.id)])
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`.slice(0, 48)
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 48)
}

/* ------------------------------------------------------------- theme files */

export function parseThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.")
  if (value.version !== THEME_FILE_VERSION) {
    throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`)
  }
  const name = value.name
  const appearance = value.appearance
  if (!isThemeLabel(name)) throw new Error("Theme files need a name (48 characters or fewer).")
  if (!isThemeAppearance(appearance)) throw new Error('Theme files need an appearance of "light" or "dark".')
  if (!isRecord(value.colors)) throw new Error("Theme files need a colors object.")

  const id = value.id === undefined ? themeIdFromName(name) : value.id
  if (!isThemeId(id)) throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.")
  if (RESERVED_THEME_IDS.has(id)) throw new Error(`The theme id "${id}" is reserved.`)

  const overrides = parseOverrides(value.colors)
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {}
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.")
    for (const [variantAppearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(variantAppearance)) throw new Error('Theme variants may only be named "light" or "dark".')
      if (variantAppearance === appearance) {
        throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`)
      }
      variants[variantAppearance] = {
        ...getDefaultThemeColors(variantAppearance),
        ...parseOverrides(variantColors),
      }
    }
  }

  return {
    id,
    label: name.trim(),
    appearance,
    colors: { ...getDefaultThemeColors(appearance), ...overrides },
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  }
}

function parseOverrides(value: unknown): ThemeColorOverrides {
  if (!isRecord(value)) throw new Error("Theme colors must be objects.")
  const overrides: Partial<Record<ThemeColorRole, string>> = {}
  for (const [role, color] of Object.entries(value)) {
    if (!THEME_COLOR_ROLE_SET.has(role)) throw new Error(`"${role}" is not a supported theme color role.`)
    const normalized = toCanonicalColor(color)
    if (!normalized) {
      throw new Error(`The color for "${role}" must be a literal CSS color such as oklch(0.62 0.2 280).`)
    }
    overrides[role as ThemeColorRole] = normalized
  }
  if (Object.keys(overrides).length === 0) throw new Error("Add at least one color role to the theme file.")
  return overrides
}

export function serializeThemeFile(theme: ThemeDefinition): string {
  const canonical = canonicalise(theme)
  const file: ThemeFile = {
    version: THEME_FILE_VERSION,
    id: canonical.id,
    name: canonical.label,
    appearance: canonical.appearance,
    colors: canonical.colors,
    ...(canonical.variants ? { variants: canonical.variants } : {}),
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/* --------------------------------------------------- guided palette engine */

/**
 * The status colours Observer shows without a theme. Generated palettes fall
 * back to these rather than the flagship theme's, so a created theme never
 * inherits a brand tint on destructive buttons and warnings.
 */
const STANDARD_STATUS_COLORS = {
  light: { error: "#fb2c36", errorForeground: "#c10007", warning: "#fe9a00", warningForeground: "#bb4d00" },
  dark: { error: "#fb414a", errorForeground: "#ff6467", warning: "#fe9a00", warningForeground: "#ffb900" },
} as const

function standardStatusColors(canvas: Rgb): Pick<
  ThemeColors,
  "error" | "errorForeground" | "errorSurface" | "warning" | "warningForeground" | "warningSurface"
> {
  const appearance: ThemeAppearance = isDarkSurface(canvas) ? "dark" : "light"
  const standard = STANDARD_STATUS_COLORS[appearance]
  const surfaceMix = appearance === "dark" ? 0.16 : 0.08
  const surfaceOf = (value: string): Rgb => mixRgb(canvas, colorToRgb(value, canvas), surfaceMix)
  const readableOn = (foreground: string, surface: Rgb): string =>
    oklchToColor(
      solveLightness(rgbToOklch(colorToRgb(foreground, canvas)), surface, 4.6, appearance === "dark" ? "lighter" : "darker"),
    )
  const errorSurface = surfaceOf(standard.error)
  const warningSurface = surfaceOf(standard.warning)
  return {
    error: toCanonicalColor(standard.error) as string,
    errorForeground: readableOn(standard.errorForeground, errorSurface),
    errorSurface: rgbToColor(errorSurface),
    warning: toCanonicalColor(standard.warning) as string,
    warningForeground: readableOn(standard.warningForeground, warningSurface),
    warningSurface: rgbToColor(warningSurface),
  }
}

/** A background tint should support the chosen mode, not saturate the app. */
function managedBackground(value: string, appearance: ThemeAppearance): Rgb {
  const selected = colorToRgb(value, appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 })
  const hsl = rgbToHsl(selected)
  return hslToRgb({
    h: hsl.h,
    s: Math.min(hsl.s, appearance === "dark" ? 0.3 : 0.2),
    l: appearance === "dark" ? Math.min(0.13, Math.max(0.07, hsl.l)) : Math.min(0.985, Math.max(0.94, hsl.l)),
  })
}

/** Nudges the seed accent to the nearest readable lightness on the canvas. */
function managedAccent(value: string, appearance: ThemeAppearance, background: Rgb): Rgb {
  const selected = colorToRgb(value, { r: 168, g: 67, b: 112 })
  const hsl = rgbToHsl(selected)
  const preferred =
    appearance === "dark" ? Math.min(0.72, Math.max(0.42, hsl.l)) : Math.min(0.58, Math.max(0.35, hsl.l))
  const range: readonly [number, number] = appearance === "dark" ? [0.42, 0.82] : [0.22, 0.58]
  const saturation = Math.min(hsl.s, 0.82)
  const candidates = Array.from({ length: 61 }, (_, index) => {
    const lightness = range[0] + ((range[1] - range[0]) * index) / 60
    const color = hslToRgb({ h: hsl.h, s: saturation, l: lightness })
    return { color, lightness, contrast: contrastRatio(color, background) }
  })
  // Leave a little room for browser colour conversion at render time.
  const readable = candidates.filter((candidate) => candidate.contrast >= 4.7)
  const pool = readable.length > 0 ? readable : candidates
  return pool.reduce((best, candidate) => {
    const distance = Math.abs(candidate.lightness - preferred)
    const bestDistance = Math.abs(best.lightness - preferred)
    return distance < bestDistance || (distance === bestDistance && candidate.contrast > best.contrast) ? candidate : best
  }).color
}

/**
 * Creates the palette behind the theme editor: two user colours set the mood,
 * every dependent role is generated together so text, surfaces, code and the
 * sidebar stay coherent and readable.
 */
export function createManagedThemeColors(
  appearance: ThemeAppearance,
  backgroundValue: string,
  accentValue: string,
  options?: { exactSeeds?: boolean },
): ThemeColors {
  const defaults = getDefaultThemeColors(appearance)
  const canvas = options?.exactSeeds
    ? colorToRgb(backgroundValue, appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 })
    : managedBackground(backgroundValue, appearance)
  const accent = options?.exactSeeds
    ? colorToRgb(accentValue, { r: 168, g: 67, b: 112 })
    : managedAccent(accentValue, appearance, canvas)
  const dark = appearance === "dark"

  const text = readableForeground(canvas)
  const textMuted = mutedText(canvas, text)
  const sidebar = mixRgb(canvas, accent, 0.08)
  const surfaceRaised = mixRgb(canvas, text, dark ? 0.12 : 0.035)
  const surfaceOverlay = mixRgb(canvas, text, dark ? 0.18 : 0.06)
  const secondary = mixRgb(canvas, accent, dark ? 0.2 : 0.08)
  const muted = mixRgb(canvas, accent, dark ? 0.13 : 0.06)
  const accentSurface = mixRgb(canvas, accent, dark ? 0.3 : 0.14)
  const messageSurface = mixRgb(canvas, accent, dark ? 0.36 : 0.18)
  const toolbarControl = mixRgb(canvas, accent, dark ? 0.2 : 0.08)
  const toolbarBorder = mixRgb(canvas, accent, dark ? 0.35 : 0.14)
  const accentForeground = readableForeground(accent)
  // Code and terminal are large surfaces: they keep the canvas hue rather than
  // drifting toward the foreground grey.
  const codeBackground = mixRgb(canvas, text, dark ? 0.06 : 0.025)
  const updateSurface = mixRgb(canvas, accent, dark ? 0.32 : 0.16)
  const white: Rgb = { r: 255, g: 255, b: 255 }
  const black: Rgb = { r: 0, g: 0, b: 0 }
  const actionHover = mixRgb(accent, relativeIsLight(accentForeground) ? black : white, 0.12)

  return {
    ...defaults,
    ...standardStatusColors(canvas),
    update: rgbToColor(accent),
    updateForeground: rgbToColor(mixRgb(accent, dark ? white : black, 0.35)),
    updateSurface: rgbToColor(updateSurface),
    canvas: rgbToColor(canvas),
    chrome: rgbToColor(canvas),
    toolbar: rgbToColor(canvas),
    toolbarForeground: rgbToColor(text),
    toolbarBorder: rgbToColor(toolbarBorder),
    toolbarControl: rgbToColor(toolbarControl),
    toolbarControlForeground: rgbToColor(text),
    toolbarControlHover: rgbToColor(accentSurface),
    surface: rgbToColor(canvas),
    surfaceRaised: rgbToColor(surfaceRaised),
    surfaceOverlay: rgbToColor(surfaceOverlay),
    text: rgbToColor(text),
    textMuted: rgbToColor(textMuted),
    border: rgbToColor(mixRgb(mixRgb(canvas, accent, dark ? 0.22 : 0.1), text, 0.1)),
    input: rgbToColor(mixRgb(mixRgb(canvas, accent, dark ? 0.3 : 0.14), text, dark ? 0.14 : 0.13)),
    focus: rgbToColor(accent),
    accent: rgbToColor(accent),
    accentForeground: rgbToColor(accentForeground),
    secondary: rgbToColor(secondary),
    secondaryForeground: rgbToColor(readableForeground(secondary)),
    muted: rgbToColor(muted),
    mutedForeground: rgbToColor(mutedText(muted, text)),
    placeholder: rgbToColor(mutedText(surfaceRaised, text)),
    secondaryLabel: rgbToColor(textMuted),
    iconMuted: rgbToColor(textMuted),
    accentSurface: rgbToColor(accentSurface),
    accentSurfaceForeground: rgbToColor(readableForeground(accentSurface)),
    messageSurface: rgbToColor(messageSurface),
    messageForeground: rgbToColor(readableForeground(messageSurface)),
    messageAction: rgbToColor(accent),
    messageActionForeground: rgbToColor(accentForeground),
    messageActionHover: rgbToColor(actionHover),
    codeBackground: rgbToColor(codeBackground),
    codeForeground: rgbToColor(readableForeground(codeBackground)),
    sidebar: rgbToColor(sidebar),
    sidebarForeground: rgbToColor(readableForeground(sidebar)),
    sidebarMutedForeground: rgbToColor(mutedText(sidebar, text)),
    sidebarControlSurface: rgbToColor(mixRgb(sidebar, text, dark ? 0.16 : 0.08)),
    sidebarRowHover: rgbToColor(mixRgb(sidebar, accent, 0.12)),
    sidebarRowActive: rgbToColor(mixRgb(sidebar, accent, 0.2)),
    sidebarRowSelected: rgbToColor(mixRgb(sidebar, accent, 0.24)),
    sidebarBorder: rgbToColor(mixRgb(sidebar, text, dark ? 0.35 : 0.12)),
    terminalBackground: rgbToColor(canvas),
    terminalForeground: rgbToColor(readableForeground(canvas)),
    terminalCursor: rgbToColor(accent),
    terminalSelection: rgbToColor(mixRgb(canvas, accent, dark ? 0.35 : 0.18)),
    terminalScrollbar: rgbToColor(mixRgb(canvas, text, dark ? 0.42 : 0.22)),
    terminalScrollbarHover: rgbToColor(mixRgb(canvas, text, dark ? 0.55 : 0.32)),
  }
}

function relativeIsLight(color: Rgb): boolean {
  return !isDarkSurface(color)
}

/** The colour a preview swatch should paint for a role, whatever the mode. */
export function themeSwatch(theme: ThemeDefinition, appearance: ThemeAppearance, role: ThemeColorRole): string {
  const colors = getThemeColorsForMode(theme, appearance) ?? theme.colors
  const value = colors[role]
  return isThemeColor(value) ? value : (theme.colors[role] as string)
}

export { oklchToRgb }
export type { ThemeAppearance, ThemeColorRole, ThemeColors, ThemeDefinition, ThemeVariants }

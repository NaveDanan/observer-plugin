/**
 * Applying a theme to the document, and the hook the Appearance tab drives.
 *
 * Three coordinated mechanisms, exactly as T3 Code does it:
 *   1. `.dark` on `<html>` — drives every `@variant dark` rule.
 *   2. `data-theme-id` on `<html>` — switches the semantic layer over to the
 *      `--app-theme-*` variables (see index.css).
 *   3. inline `--app-theme-*` properties — the resolved role values.
 *
 * Preferences live in `localStorage` under `observer:*`. The module applies
 * the stored theme on import so the first paint is already correct.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react"
import { THEME_COLOR_ROLES, type ThemeAppearance, type ThemeColorRole, type ThemeColors } from "./palettes"
import {
  getCustomThemes,
  getThemeColorsForMode,
  getThemeDefinition,
  getThemePreferenceMode,
  invalidateCustomThemes,
  isKnownThemePreference,
  subscribeToCustomThemes,
  type ThemePreference,
  type ThemePreferenceMode,
} from "./library"

const THEME_STORAGE_KEY = "observer:theme"
const APPEARANCE_MODE_STORAGE_KEY = "observer:theme-appearance-mode"
const THEME_HALVES_STORAGE_KEY = "observer:theme-halves:v1"
const MEDIA_QUERY = "(prefers-color-scheme: dark)"

/** An automatic-mode mix: a different theme per resolved appearance. */
export type ThemeHalves = Readonly<{ light?: string; dark?: string }>

interface ThemeSnapshot {
  theme: ThemePreference
  systemDark: boolean
  appearanceMode: ThemePreferenceMode
  themeHalves: ThemeHalves | null
}

const DEFAULT_SNAPSHOT: ThemeSnapshot = {
  theme: "system",
  systemDark: false,
  appearanceMode: "system",
  themeHalves: null,
}

/** Role -> CSS custom property. The names match T3 Code's, so themes port. */
const APP_THEME_VARIABLES = Object.fromEntries(
  THEME_COLOR_ROLES.map((role) => [role, `--app-theme-${kebab(role)}`]),
) as Readonly<Record<ThemeColorRole, string>>

function kebab(role: string): string {
  // `terminalSelection` is the one role whose variable is not a plain
  // kebab-case of its name; T3 Code calls it `-background` and theme files
  // written against either app must land on the same property.
  if (role === "terminalSelection") return "terminal-selection-background"
  return role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

export function getThemeColorVariable(role: ThemeColorRole): string {
  return APP_THEME_VARIABLES[role]
}

/* ------------------------------------------------------------ preferences */

function readStoredTheme(): ThemePreference {
  if (typeof window === "undefined") return DEFAULT_SNAPSHOT.theme
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (raw !== null && isKnownThemePreference(raw)) return raw
  } catch {
    // Storage can be denied outright (private mode, file://). The stock look
    // is a working app, so a failed read is not worth reporting to the user.
  }
  return DEFAULT_SNAPSHOT.theme
}

export function readAppearanceModePreference(theme: ThemePreference = readStoredTheme()): ThemePreferenceMode {
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(APPEARANCE_MODE_STORAGE_KEY)
      if (raw === "light" || raw === "dark" || raw === "system") return raw
    } catch {
      // Fall through to inferring the mode from the theme itself.
    }
  }
  return theme === "system" ? "system" : (getThemePreferenceMode(theme) ?? "light")
}

export function readThemeHalves(): ThemeHalves | null {
  if (typeof window === "undefined") return null
  try {
    return parseThemeHalves(window.localStorage.getItem(THEME_HALVES_STORAGE_KEY))
  } catch {
    return null
  }
}

/**
 * Halves only name real themes that can render their half; a stale mix
 * degrades to the base preference instead of painting a missing palette.
 */
export function parseThemeHalves(raw: string | null): ThemeHalves | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== "object" || value === null) return null
    const halves: { light?: string; dark?: string } = {}
    for (const appearance of ["light", "dark"] as const) {
      const themeId = (value as Record<string, unknown>)[appearance]
      if (typeof themeId !== "string") continue
      const definition = getThemeDefinition(themeId)
      if (definition && getThemeColorsForMode(definition, appearance) !== null) halves[appearance] = definition.id
    }
    return halves.light !== undefined || halves.dark !== undefined ? halves : null
  } catch {
    return null
  }
}

export function resolveThemeAppearance(
  theme: ThemePreference,
  systemDark: boolean,
  appearanceMode: ThemePreferenceMode,
  halves: ThemeHalves | null,
): ThemeAppearance {
  const systemAppearance: ThemeAppearance = systemDark ? "dark" : "light"
  const mode = appearanceMode === "system" ? systemAppearance : appearanceMode
  // A configured half guarantees the appearance is renderable even when the
  // base theme lacks that mode.
  if (halves?.[mode]) return mode
  const definition = getThemeDefinition(theme)
  return definition && getThemeColorsForMode(definition, mode) === null ? definition.appearance : mode
}

/** The theme that should render the given appearance under a mix, if any. */
export function resolveThemeHalf(
  theme: ThemePreference,
  halves: ThemeHalves | null,
  appearance: ThemeAppearance,
): ThemePreference {
  return halves?.[appearance] ?? theme
}

/* -------------------------------------------------------------- applying */

/** Marks the document as wearing an unsaved draft rather than a stored theme. */
export const THEME_PREVIEW_ID = "__preview"

function writeRoles(root: HTMLElement, colors: ThemeColors): void {
  for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) {
    root.style.setProperty(APP_THEME_VARIABLES[role], value)
  }
}

export function applyThemePalette(theme: ThemePreference, appearance?: ThemeAppearance): void {
  if (typeof document === "undefined") return
  const root = document.documentElement
  if (!root?.style) return

  const palette = getThemeDefinition(theme)
  if (palette) {
    root.dataset.themeId = palette.id
    const mode = appearance ?? palette.appearance
    writeRoles(root, getThemeColorsForMode(palette, mode) ?? palette.colors)
    return
  }

  // No theme installed: strip the role variables so the stock zinc tokens in
  // index.css take back over.
  delete root.dataset.themeId
  for (const variable of Object.values(APP_THEME_VARIABLES)) root.style.removeProperty(variable)
}

/**
 * Paints a draft palette onto the live app without installing it, so the
 * editor is judged against the real interface instead of a miniature.
 */
export function applyThemeColorPreview(colors: ThemeColors, appearance: ThemeAppearance): void {
  if (typeof document === "undefined") return
  const root = document.documentElement
  if (!root?.style) return
  root.dataset.themeId = THEME_PREVIEW_ID
  root.classList.toggle("dark", appearance === "dark")
  writeRoles(root, colors)
}

let lastApplied: string | null = null

function applyTheme(theme: ThemePreference, suppressTransitions = false): void {
  if (typeof document === "undefined" || typeof window === "undefined") return
  const appearanceMode = readAppearanceModePreference(theme)
  const systemDark = appearanceMode === "system" ? getSystemDark() : false
  const halves = readThemeHalves()
  const signature = `${theme}|${appearanceMode}|${systemDark}|${halves?.light ?? ""}|${halves?.dark ?? ""}`
  if (lastApplied === signature) return

  if (suppressTransitions) document.documentElement.classList.add("no-transitions")
  const appearance = resolveThemeAppearance(theme, systemDark, appearanceMode, halves)
  applyThemePalette(resolveThemeHalf(theme, halves, appearance), appearance)
  document.documentElement.classList.toggle("dark", appearance === "dark")
  lastApplied = signature
  syncBrowserChrome()
  if (suppressTransitions) {
    // Force a reflow so the class lands before it is taken away again.
    void document.documentElement.offsetHeight
    requestAnimationFrame(() => document.documentElement.classList.remove("no-transitions"))
  }
}

/** Keeps the browser's own chrome (address bar, overscroll) on the palette. */
function syncBrowserChrome(): void {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return
  const background = getComputedStyle(document.body).backgroundColor
  if (!background || background === "rgba(0, 0, 0, 0)") return
  document.documentElement.style.backgroundColor = background
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement("meta")
    meta.name = "theme-color"
    document.head.append(meta)
  }
  meta.setAttribute("content", background)
}

function getSystemDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches
  )
}

/* --------------------------------------------------------------- the store */

let listeners: Array<() => void> = []
let snapshot: ThemeSnapshot | null = null
let stale = true
let removeWindowListeners: (() => void) | null = null

function emitChange(): void {
  stale = true
  for (const listener of listeners) listener()
}

function getSnapshot(): ThemeSnapshot {
  if (typeof window === "undefined") return DEFAULT_SNAPSHOT
  if (!stale && snapshot) return snapshot
  stale = false
  const theme = readStoredTheme()
  const appearanceMode = readAppearanceModePreference(theme)
  const next: ThemeSnapshot = {
    theme,
    appearanceMode,
    systemDark: appearanceMode === "system" ? getSystemDark() : false,
    themeHalves: readThemeHalves(),
  }
  if (
    snapshot &&
    snapshot.theme === next.theme &&
    snapshot.appearanceMode === next.appearanceMode &&
    snapshot.systemDark === next.systemDark &&
    snapshot.themeHalves?.light === next.themeHalves?.light &&
    snapshot.themeHalves?.dark === next.themeHalves?.dark
  ) {
    return snapshot
  }
  snapshot = next
  return snapshot
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  listeners.push(listener)

  if (!removeWindowListeners) {
    const media = typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY) : null
    const onSystemChange = (): void => {
      if (readAppearanceModePreference() === "system") {
        lastApplied = null
        applyTheme(readStoredTheme(), true)
      }
      emitChange()
    }
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null) invalidateCustomThemes()
      if (event.key === "observer:themes:v1") invalidateCustomThemes()
      lastApplied = null
      applyTheme(readStoredTheme(), true)
      emitChange()
    }
    media?.addEventListener("change", onSystemChange)
    window.addEventListener("storage", onStorage)
    const unsubscribeThemes = subscribeToCustomThemes(() => {
      lastApplied = null
      applyTheme(readStoredTheme(), true)
      emitChange()
    })
    removeWindowListeners = () => {
      media?.removeEventListener("change", onSystemChange)
      window.removeEventListener("storage", onStorage)
      unsubscribeThemes()
    }
  }

  return () => {
    listeners = listeners.filter((entry) => entry !== listener)
    if (listeners.length === 0) {
      removeWindowListeners?.()
      removeWindowListeners = null
    }
  }
}

// Apply on module load so the first paint already wears the stored theme.
if (typeof document !== "undefined" && typeof window !== "undefined") applyTheme(readStoredTheme())

function write(key: string, value: string | null): boolean {
  if (typeof window === "undefined") return false
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

export function useTheme() {
  const state = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_SNAPSHOT)
  const theme = state.theme
  const resolvedTheme = resolveThemeAppearance(theme, state.systemDark, state.appearanceMode, state.themeHalves)

  const setTheme = useCallback((next: ThemePreference): boolean => {
    // Choosing a whole theme replaces any per-appearance mix.
    write(THEME_HALVES_STORAGE_KEY, null)
    if (!write(THEME_STORAGE_KEY, next)) return false
    lastApplied = null
    applyTheme(next, true)
    emitChange()
    return true
  }, [])

  const setAppearanceMode = useCallback((mode: ThemePreferenceMode): boolean => {
    if (!write(APPEARANCE_MODE_STORAGE_KEY, mode)) return false
    lastApplied = null
    applyTheme(readStoredTheme(), true)
    emitChange()
    return true
  }, [])

  const setThemeHalf = useCallback((appearance: ThemeAppearance, themeId: string | null): boolean => {
    const current = readThemeHalves() ?? {}
    const next: { light?: string; dark?: string } = { ...current }
    if (themeId === null) delete next[appearance]
    else next[appearance] = themeId
    const empty = next.light === undefined && next.dark === undefined
    if (!write(THEME_HALVES_STORAGE_KEY, empty ? null : JSON.stringify(next))) return false
    lastApplied = null
    applyTheme(readStoredTheme(), true)
    emitChange()
    return true
  }, [])

  const clearThemeHalves = useCallback((): boolean => {
    if (!write(THEME_HALVES_STORAGE_KEY, null)) return false
    lastApplied = null
    applyTheme(readStoredTheme(), true)
    emitChange()
    return true
  }, [])

  /** Repaints from storage — used after installing, editing or removing. */
  const refreshTheme = useCallback((): void => {
    lastApplied = null
    applyTheme(readStoredTheme(), true)
    emitChange()
  }, [])

  useEffect(() => {
    applyTheme(theme)
  }, [state.appearanceMode, theme])

  return {
    theme,
    resolvedTheme,
    appearanceMode: state.appearanceMode,
    themeHalves: state.themeHalves,
    customThemes: getCustomThemes(),
    setTheme,
    setAppearanceMode,
    setThemeHalf,
    clearThemeHalves,
    refreshTheme,
  } as const
}

export { readStoredTheme }
export type { ThemePreference, ThemePreferenceMode }

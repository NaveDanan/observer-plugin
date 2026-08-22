/**
 * Appearance preferences that are not the palette: typography, glass opacity
 * and word wrap.
 *
 * These are local-only, like the theme itself — they describe this browser,
 * not the daemon — and they are applied by writing CSS custom properties onto
 * `<html>`, so every surface picks them up without a re-render.
 */

import { useCallback, useSyncExternalStore } from "react"

export const DEFAULT_SANS_FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
export const DEFAULT_MONO_FONT_STACK =
  'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace'

export const MIN_INTERFACE_FONT_SIZE = 12
export const MAX_INTERFACE_FONT_SIZE = 20
export const MIN_CODE_FONT_SIZE = 10
export const MAX_CODE_FONT_SIZE = 18
export const MIN_GLASS_OPACITY = 40
export const MAX_GLASS_OPACITY = 100
export const GLASS_OPACITY_STEP = 5

export interface AppearanceSettings {
  /** Empty means "use the stack in index.css". */
  interfaceFont: string
  interfaceFontSize: number
  monoFont: string
  monoFontSize: number
  glassOpacity: number
  wordWrap: boolean
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  interfaceFont: "",
  interfaceFontSize: 14,
  monoFont: "",
  monoFontSize: 13,
  glassOpacity: 80,
  wordWrap: true,
}

const STORAGE_KEY = "observer:appearance:v1"

/**
 * Fonts vendored with the app, offered first in the picker.
 *
 * They are already on disk (docs/privacy.md rules out a font CDN), so they are
 * the one choice guaranteed to render the same on every machine.
 */
export const BUNDLED_FONTS = ["JetBrains Mono", "Inter"] as const

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function coerce(raw: unknown): AppearanceSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_APPEARANCE
  const value = raw as Partial<Record<keyof AppearanceSettings, unknown>>
  const size = (input: unknown, fallback: number, min: number, max: number): number =>
    typeof input === "number" && Number.isFinite(input) ? clamp(Math.round(input), min, max) : fallback
  return {
    interfaceFont: typeof value.interfaceFont === "string" ? value.interfaceFont : DEFAULT_APPEARANCE.interfaceFont,
    interfaceFontSize: size(
      value.interfaceFontSize,
      DEFAULT_APPEARANCE.interfaceFontSize,
      MIN_INTERFACE_FONT_SIZE,
      MAX_INTERFACE_FONT_SIZE,
    ),
    monoFont: typeof value.monoFont === "string" ? value.monoFont : DEFAULT_APPEARANCE.monoFont,
    monoFontSize: size(value.monoFontSize, DEFAULT_APPEARANCE.monoFontSize, MIN_CODE_FONT_SIZE, MAX_CODE_FONT_SIZE),
    glassOpacity: size(value.glassOpacity, DEFAULT_APPEARANCE.glassOpacity, MIN_GLASS_OPACITY, MAX_GLASS_OPACITY),
    wordWrap: typeof value.wordWrap === "boolean" ? value.wordWrap : DEFAULT_APPEARANCE.wordWrap,
  }
}

function read(): AppearanceSettings {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? coerce(JSON.parse(raw)) : DEFAULT_APPEARANCE
  } catch {
    return DEFAULT_APPEARANCE
  }
}

/** Quotes a family name so `JetBrains Mono` survives as one token. */
function fontStack(family: string, fallback: string): string {
  const trimmed = family.trim()
  if (trimmed.length === 0) return fallback
  const quoted = /^["']|,/.test(trimmed) ? trimmed : `"${trimmed}"`
  return `${quoted}, ${fallback}`
}

export function applyAppearance(settings: AppearanceSettings): void {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.style.setProperty("--font-sans", fontStack(settings.interfaceFont, DEFAULT_SANS_FONT_STACK))
  root.style.setProperty("--font-mono", fontStack(settings.monoFont, DEFAULT_MONO_FONT_STACK))
  root.style.setProperty("--app-font-size", `${settings.interfaceFontSize}px`)
  root.style.setProperty("--font-size-code", `${settings.monoFontSize}px`)
  root.style.setProperty("--glass-opacity", `${settings.glassOpacity}%`)
  root.dataset.wordWrap = settings.wordWrap ? "on" : "off"
}

let state = read()
let listeners: Array<() => void> = []

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((entry) => entry !== listener)
  }
}

export function getAppearance(): AppearanceSettings {
  return state
}

export function setAppearance(patch: Partial<AppearanceSettings>): void {
  state = coerce({ ...state, ...patch })
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // A rejected write costs persistence, not the live change below.
  }
  applyAppearance(state)
  emit()
}

export function resetAppearance(keys: ReadonlyArray<keyof AppearanceSettings>): void {
  const patch: Partial<AppearanceSettings> = {}
  for (const key of keys) Object.assign(patch, { [key]: DEFAULT_APPEARANCE[key] })
  setAppearance(patch)
}

export function useAppearance(): AppearanceSettings {
  return useSyncExternalStore(subscribe, getAppearance, () => DEFAULT_APPEARANCE)
}

export function useSetAppearance(): (patch: Partial<AppearanceSettings>) => void {
  return useCallback((patch: Partial<AppearanceSettings>) => setAppearance(patch), [])
}

/**
 * The families installed on this machine, when the browser will say.
 *
 * The Local Font Access API is Chromium-only and prompts for permission, so
 * every caller has to cope with an empty list — the picker falls back to a
 * validated free-text field, which is what a user with an exotic font needs
 * anyway.
 */
export async function discoverInstalledFonts(): Promise<string[]> {
  const query = (window as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts
  if (typeof query !== "function") return []
  try {
    const fonts = await query()
    return [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/** Whether a family actually resolves, so the picker can flag a typo. */
export function isFontFamilyAvailable(family: string): boolean {
  const trimmed = family.trim()
  if (trimmed.length === 0) return true
  if ((BUNDLED_FONTS as readonly string[]).includes(trimmed)) return true
  if (typeof document === "undefined" || typeof document.fonts?.check !== "function") return true
  try {
    return document.fonts.check(`12px "${trimmed}"`)
  } catch {
    return true
  }
}

// Apply on module load, before React mounts, so nothing reflows on boot.
applyAppearance(state)

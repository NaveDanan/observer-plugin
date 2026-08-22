/**
 * The Appearance tab: what Observer looks like, and none of it is the daemon's
 * business.
 *
 * Everything on this page is stored in `localStorage` — the palette, the
 * appearance mode, the fonts, the glass. That is deliberate: a look describes
 * *this browser*, not the machine's capture config, and it means the tab keeps
 * working with full fidelity while the daemon is down and General and Providers
 * are showing an error.
 *
 * The structure is T3 Code's Appearance tab: mode tiles painted in the real
 * palette on top, then a library of two-ball cards, then the typography rows.
 * The one model worth stating up front is the pair: light and dark are owned
 * separately. `theme` is the base preference; `themeHalves` overrides one side
 * of it. So clicking a card's dark ball leaves your light theme alone, and the
 * mode tiles above show you the consequence before you commit to it.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { PaintbrushIcon, PaletteIcon, PlusIcon, TypeIcon } from "lucide-react"
import { Button, Dialog, SettingResetButton, SettingsRow, SettingsSection, Slider, Switch } from "../ui/primitives"
import { cn } from "../lib/utils"
import { T3_CODE_THEME, T3_CODE_THEME_ID } from "../theme/palettes"
import type { ThemeAppearance, ThemeColors, ThemeDefinition } from "../theme/palettes"
import {
  getCustomThemes,
  getLibraryThemes,
  getThemeColorsForMode,
  getThemeDefinition,
  getThemeModes,
  removeCustomTheme,
  serializeThemeFile,
  subscribeToCustomThemes,
} from "../theme/library"
import { useTheme } from "../theme/useTheme"
import {
  DEFAULT_APPEARANCE,
  DEFAULT_MONO_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  GLASS_OPACITY_STEP,
  MAX_CODE_FONT_SIZE,
  MAX_GLASS_OPACITY,
  MAX_INTERFACE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_GLASS_OPACITY,
  MIN_INTERFACE_FONT_SIZE,
  discoverInstalledFonts,
  resetAppearance,
  setAppearance,
  useAppearance,
} from "../theme/appearance"
import { ThemeWireframe } from "./appearance/ThemeWireframe"
import { ThemeLibraryCard } from "./appearance/ThemeLibraryCard"
import { ThemeEditorDialog, type ThemeEditorRequest } from "./appearance/ThemeEditorDialog"
import { ThemeImportDialog } from "./appearance/ThemeImportDialog"
import { FontFamilyField, FontFamilySelect, FontPreview, FontSizeSelect } from "./appearance/typography"

const APPEARANCE_MODES = ["system", "light", "dark"] as const
type AppearanceModeOption = (typeof APPEARANCE_MODES)[number]

const MODE_LABELS: Record<AppearanceModeOption, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
}

const INTERFACE_PREVIEW = "The quick brown fox jumps over the lazy dog — 0123456789"
const MONO_PREVIEW = 'const seat = employees["arjun-mehta"] // 0O 1lI'

function downloadThemeFile(theme: ThemeDefinition): void {
  const url = URL.createObjectURL(new Blob([serializeThemeFile(theme)], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `${theme.id}.json`
  anchor.click()
  // Revoking synchronously aborts the download in some browsers; the stream has
  // to be opened first.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function AppearancePanel(): JSX.Element {
  const { theme, resolvedTheme, appearanceMode, themeHalves, setTheme, setAppearanceMode, setThemeHalf, refreshTheme } =
    useTheme()
  const settings = useAppearance()

  /**
   * The library, re-read whenever a theme is installed, edited or removed.
   *
   * `useTheme`'s own snapshot deliberately does not change when only the user's
   * theme list does — it compares preferences, not contents — so a card grid
   * driven off it would keep showing a theme that was just deleted.
   */
  const customThemes = useSyncExternalStore(subscribeToCustomThemes, getCustomThemes, getCustomThemes)
  const library = useMemo(() => getLibraryThemes(), [customThemes])

  const [installedFonts, setInstalledFonts] = useState<ReadonlyArray<string>>([])
  const [importOpen, setImportOpen] = useState(false)
  const [editor, setEditor] = useState<ThemeEditorRequest | null>(null)
  const [pendingRemoval, setPendingRemoval] = useState<ThemeDefinition | null>(null)

  useEffect(() => {
    let cancelled = false
    void discoverInstalledFonts().then((fonts) => {
      if (!cancelled) setInstalledFonts(fonts)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Which theme paints each side right now: a half if one is set, the base
  // preference otherwise. A preference that names no installed theme ("system",
  // or one that has just been deleted) resolves to the stock look, so a fresh
  // install shows T3 Code selected rather than nothing at all.
  const ownerId = useCallback(
    (appearance: ThemeAppearance): string =>
      getThemeDefinition(themeHalves?.[appearance] ?? theme)?.id ?? T3_CODE_THEME_ID,
    [theme, themeHalves],
  )
  const lightOwner = ownerId("light")
  const darkOwner = ownerId("dark")

  const ownerColors = useCallback(
    (appearance: ThemeAppearance): ThemeColors => {
      const definition = getThemeDefinition(appearance === "light" ? lightOwner : darkOwner) ?? T3_CODE_THEME
      return getThemeColorsForMode(definition, appearance) ?? definition.colors
    },
    [darkOwner, lightOwner],
  )

  const activeAppearances = useCallback(
    (themeId: string): ReadonlyArray<ThemeAppearance> => {
      const owned: ThemeAppearance[] = []
      if (lightOwner === themeId) owned.push("light")
      if (darkOwner === themeId) owned.push("dark")
      return owned
    },
    [darkOwner, lightOwner],
  )

  const isCustom = useCallback(
    (themeId: string): boolean => customThemes.some((candidate) => candidate.id === themeId),
    [customThemes],
  )

  /**
   * Choosing a whole card. A theme that only ships one appearance takes that
   * half of the mix instead of becoming the base for both — otherwise picking a
   * light-only theme would leave dark mode painting somebody else's palette
   * with no way to see why.
   */
  const selectWholeTheme = useCallback(
    (definition: ThemeDefinition): void => {
      const modes = getThemeModes(definition)
      const only = modes.length === 1 ? modes[0] : undefined
      if (only !== undefined) setThemeHalf(only, definition.id)
      else setTheme(definition.id)
    },
    [setTheme, setThemeHalf],
  )

  const removeTheme = useCallback(
    (target: ThemeDefinition): void => {
      // Move the selection off the theme before it stops existing, so nothing
      // stored ever names a theme that is not installed.
      const surviving = (["light", "dark"] as const).flatMap((appearance) => {
        const half = themeHalves?.[appearance]
        return half !== undefined && half !== target.id ? [[appearance, half] as const] : []
      })
      if (theme === target.id) {
        // Writing a base preference clears the whole mix, so the halves that
        // named a surviving theme are written back afterwards.
        setTheme(T3_CODE_THEME_ID)
        for (const [appearance, half] of surviving) setThemeHalf(appearance, half)
      } else {
        for (const appearance of ["light", "dark"] as const) {
          if (themeHalves?.[appearance] === target.id) setThemeHalf(appearance, null)
        }
      }
      removeCustomTheme(target.id)
      refreshTheme()
    },
    [refreshTheme, setTheme, setThemeHalf, theme, themeHalves],
  )

  const closeEditor = useCallback((): void => {
    setEditor(null)
    // The document is wearing an uninstalled draft; put the stored theme back.
    refreshTheme()
  }, [refreshTheme])

  const interfaceIsDefault =
    settings.interfaceFont === DEFAULT_APPEARANCE.interfaceFont &&
    settings.interfaceFontSize === DEFAULT_APPEARANCE.interfaceFontSize
  const monoIsDefault =
    settings.monoFont === DEFAULT_APPEARANCE.monoFont && settings.monoFontSize === DEFAULT_APPEARANCE.monoFontSize

  return (
    <>
      <SettingsSection title="Appearance" icon={<PaletteIcon className="size-4.5 text-muted-foreground" />}>
        <SettingsRow
          id="setting-appearance-mode"
          title="Colour scheme"
          description="Follow the system, or pin Observer to light or dark. Each tile is painted in the palette that actually owns that side, so the System tile shows the two themes you will be switching between."
        >
          <div role="group" aria-label="Colour scheme" className="grid grid-cols-3 gap-2 pt-3 pb-2">
            {APPEARANCE_MODES.map((mode) => {
              const isActive = appearanceMode === mode
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={isActive}
                  aria-label={mode === "system" ? "Follow the system appearance" : `Use ${mode} mode`}
                  onClick={() => setAppearanceMode(mode)}
                  style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
                  className={cn(
                    "flex cursor-pointer flex-col items-stretch gap-1.5 rounded-xl border p-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    isActive ? "border-transparent bg-accent/30" : "border-border/70 bg-card/60 hover:bg-accent/10",
                  )}
                >
                  <ThemeWireframe
                    className="h-[8.75rem]"
                    panes={
                      mode === "system"
                        ? [
                            { colors: ownerColors("light"), clip: "left" },
                            { colors: ownerColors("dark"), clip: "right" },
                          ]
                        : [{ colors: ownerColors(mode) }]
                    }
                  />
                  <span
                    className={cn(
                      "flex items-center justify-center text-xs font-medium",
                      isActive ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {MODE_LABELS[mode]}
                  </span>
                </button>
              )
            })}
          </div>
        </SettingsRow>

        <SettingsRow
          id="setting-themes"
          title="Themes"
          description="Click a card to use it for both appearances, or click one of its two balls to give it just that half — Grove by day and Ocean by night is two clicks, not a setting."
          control={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  setEditor({ editing: null, seed: null, seedName: "", appearance: resolvedTheme })
                }
              >
                <PaintbrushIcon />
                Create theme
              </Button>
              <Button size="xs" variant="outline" onClick={() => setImportOpen(true)}>
                <PlusIcon />
                Add theme
              </Button>
            </div>
          }
        >
          <div
            className="grid gap-2 pt-3 pb-2"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))" }}
          >
            {library.map((definition) => {
              const editable = isCustom(definition.id)
              const owned = activeAppearances(definition.id)
              return (
                <ThemeLibraryCard
                  key={definition.id}
                  theme={definition}
                  // "Active" means this theme owns the whole app, both halves —
                  // a card that only owns dark gets a ring on its dark ball
                  // instead, which is the more precise thing to say.
                  isActive={lightOwner === definition.id && darkOwner === definition.id}
                  activeAppearances={owned}
                  onUse={() => selectWholeTheme(definition)}
                  onUseAppearance={(appearance) => setThemeHalf(appearance, definition.id)}
                  onExport={() => downloadThemeFile(definition)}
                  onDuplicate={() =>
                    setEditor({
                      editing: null,
                      seed: definition,
                      seedName: `${definition.label} copy`,
                      appearance: resolvedTheme,
                    })
                  }
                  {...(editable
                    ? {
                        onEdit: () =>
                          setEditor({
                            editing: definition,
                            seed: definition,
                            seedName: definition.label,
                            appearance: definition.appearance,
                          }),
                        onRemove: () => setPendingRemoval(definition),
                      }
                    : {})}
                />
              )
            })}
          </div>
        </SettingsRow>

        <SettingsRow
          id="setting-glass-opacity"
          title="Glass opacity"
          description="Control how transparent glass surfaces are. Higher values make menus, dialogs, and the composer more solid."
          resetAction={
            <SettingResetButton
              label="glass opacity"
              disabled={settings.glassOpacity === DEFAULT_APPEARANCE.glassOpacity}
              onClick={() => resetAppearance(["glassOpacity"])}
            />
          }
          control={
            <>
              <Slider
                value={settings.glassOpacity}
                min={MIN_GLASS_OPACITY}
                max={MAX_GLASS_OPACITY}
                step={GLASS_OPACITY_STEP}
                ariaLabel="Glass opacity"
                onValueChange={(value) => setAppearance({ glassOpacity: value })}
              />
              <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
                {settings.glassOpacity}%
              </span>
            </>
          }
        />
      </SettingsSection>

      <SettingsSection title="Typography" icon={<TypeIcon className="size-4.5 text-muted-foreground" />}>
        <SettingsRow
          id="setting-typography"
          title="Interface font"
          description="Everything outside code blocks and the terminal."
          resetAction={
            <SettingResetButton
              label="interface font"
              disabled={interfaceIsDefault}
              onClick={() => resetAppearance(["interfaceFont", "interfaceFontSize"])}
            />
          }
          control={
            <>
              <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">
                <FontFamilySelect
                  family={settings.interfaceFont}
                  installedFonts={installedFonts}
                  ariaLabel="Interface font family"
                  onChange={(family) => setAppearance({ interfaceFont: family })}
                />
              </div>
              <FontSizeSelect
                size={settings.interfaceFontSize}
                min={MIN_INTERFACE_FONT_SIZE}
                max={MAX_INTERFACE_FONT_SIZE}
                ariaLabel="Interface font size"
                onChange={(size) => setAppearance({ interfaceFontSize: size })}
              />
            </>
          }
        >
          <FontFamilyField
            family={settings.interfaceFont}
            ariaLabel="Interface font family name"
            onChange={(family) => setAppearance({ interfaceFont: family })}
          />
          <FontPreview
            family={settings.interfaceFont}
            fallbackStack={DEFAULT_SANS_FONT_STACK}
            size={settings.interfaceFontSize}
            mono={false}
            text={INTERFACE_PREVIEW}
          />
        </SettingsRow>

        <SettingsRow
          title="Monospace font"
          description="Code blocks, diffs, file previews, and agent output."
          resetAction={
            <SettingResetButton
              label="monospace font"
              disabled={monoIsDefault}
              onClick={() => resetAppearance(["monoFont", "monoFontSize"])}
            />
          }
          control={
            <>
              <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">
                <FontFamilySelect
                  family={settings.monoFont}
                  installedFonts={installedFonts}
                  ariaLabel="Monospace font family"
                  onChange={(family) => setAppearance({ monoFont: family })}
                />
              </div>
              <FontSizeSelect
                size={settings.monoFontSize}
                min={MIN_CODE_FONT_SIZE}
                max={MAX_CODE_FONT_SIZE}
                ariaLabel="Monospace font size"
                onChange={(size) => setAppearance({ monoFontSize: size })}
              />
            </>
          }
        >
          <FontFamilyField
            family={settings.monoFont}
            ariaLabel="Monospace font family name"
            onChange={(family) => setAppearance({ monoFont: family })}
          />
          <FontPreview
            family={settings.monoFont}
            fallbackStack={DEFAULT_MONO_FONT_STACK}
            size={settings.monoFontSize}
            mono
            text={MONO_PREVIEW}
          />
        </SettingsRow>

        <SettingsRow
          id="setting-word-wrap"
          title="Word wrap"
          description="Whether long lines in code blocks, diffs and tool output wrap instead of scrolling sideways. Off keeps indentation honest at the cost of a horizontal scrollbar."
          resetAction={
            <SettingResetButton
              label="word wrap"
              disabled={settings.wordWrap === DEFAULT_APPEARANCE.wordWrap}
              onClick={() => resetAppearance(["wordWrap"])}
            />
          }
          control={
            <Switch
              checked={settings.wordWrap}
              aria-label="Word wrap"
              onCheckedChange={(checked) => setAppearance({ wordWrap: checked })}
            />
          }
        />
      </SettingsSection>

      {/* Mounted only while open, and keyed by its subject, so every visit
          reseeds from the theme it was actually opened on. */}
      {editor !== null ? (
        <ThemeEditorDialog
          key={editor.editing?.id ?? editor.seed?.id ?? "new-theme"}
          request={editor}
          onCancel={closeEditor}
          onSaved={(saved) => {
            setEditor(null)
            setTheme(saved.id)
            refreshTheme()
          }}
        />
      ) : null}

      <ThemeImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onInstalled={(installed) => {
          setImportOpen(false)
          selectWholeTheme(installed)
        }}
      />

      <Dialog
        open={pendingRemoval !== null}
        onClose={() => setPendingRemoval(null)}
        title="Remove theme"
        description={
          pendingRemoval
            ? `"${pendingRemoval.label}" will be deleted from this browser. You can bring it back by importing its JSON file.`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setPendingRemoval(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (pendingRemoval !== null) removeTheme(pendingRemoval)
                setPendingRemoval(null)
              }}
            >
              Remove theme
            </Button>
          </>
        }
      />
    </>
  )
}

/**
 * The guided theme editor: a name, an appearance, two colours.
 *
 * T3 Code's editor also has an advanced mode with a field per role and a DOM
 * inspector that highlights where each role is used. That is a tool for
 * authoring a palette from scratch; this dialog is the ninety-percent case —
 * pick a background and an accent, let `createManagedThemeColors` derive the
 * other fifty-odd roles so text, borders and surfaces stay readable together.
 * Anything more precise is what the JSON import is for.
 *
 * The preview is the app itself, not a swatch grid: every keystroke repaints
 * the live document through `applyThemeColorPreview`, so what you are judging
 * is the settings page you are standing on. That is also why closing without
 * saving has to call `refreshTheme()` — the document is wearing a draft that
 * was never installed.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { Button, Dialog, Input } from "../../ui/primitives"
import { cn } from "../../lib/utils"
import { isThemeColor, toHex } from "../../theme/colors"
import type { ThemeAppearance, ThemeColors, ThemeDefinition } from "../../theme/palettes"
import {
  createManagedThemeColors,
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeModes,
  installCustomTheme,
  themeIdFromName,
  uniqueThemeId,
  updateCustomTheme,
} from "../../theme/library"
import { applyThemeColorPreview } from "../../theme/useTheme"

/** What the editor is doing: a fresh theme, a copy, or an edit in place. */
export interface ThemeEditorRequest {
  /** The installed theme being changed, or null when creating a new one. */
  editing: ThemeDefinition | null
  /** Where the colours start from — the theme being copied or edited. */
  seed: ThemeDefinition | null
  seedName: string
  appearance: ThemeAppearance
}

interface Seeds {
  background: string
  accent: string
}

const APPEARANCES: ReadonlyArray<ThemeAppearance> = ["light", "dark"]

/** The two seed colours behind a palette, as hex the colour input can take. */
function seedsFrom(colors: ThemeColors): Seeds {
  return { background: toHex(colors.canvas) ?? "#000000", accent: toHex(colors.accent) ?? "#000000" }
}

function seedsFor(seed: ThemeDefinition | null, appearance: ThemeAppearance): Seeds {
  const colors = seed ? getThemeColorsForMode(seed, appearance) : null
  return seedsFrom(colors ?? getStandardThemeColors(appearance))
}

/**
 * A colour role's control: the platform picker for choosing, a hex field for
 * pasting one out of a design doc. The text field keeps its own draft so a
 * half-typed `#1a2` never repaints the whole app.
 */
function ColorField({
  label,
  description,
  value,
  onChange,
}: {
  label: string
  description: string
  value: string
  onChange: (hex: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [editing, value])

  const invalid = editing && toHex(draft) === null

  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          aria-label={label}
          onChange={(event) => {
            setEditing(false)
            onChange(event.currentTarget.value)
          }}
          className="h-8 w-12 shrink-0 cursor-pointer rounded-lg border border-input bg-background p-0.5"
        />
        <Input
          inputSize="sm"
          value={draft}
          spellCheck={false}
          aria-label={`${label} hex value`}
          aria-invalid={invalid || undefined}
          className={cn("font-mono", invalid && "border-destructive")}
          onChange={(event) => {
            const next = event.currentTarget.value
            setEditing(true)
            setDraft(next)
            const hex = isThemeColor(next) ? toHex(next) : null
            if (hex !== null) onChange(hex)
          }}
          onBlur={() => setEditing(false)}
        />
      </div>
      <p className="text-xs text-muted-foreground/80">{description}</p>
    </div>
  )
}

export function ThemeEditorDialog({
  request,
  onCancel,
  onSaved,
}: {
  request: ThemeEditorRequest
  /** Closing without saving; the caller repaints the stored theme. */
  onCancel: () => void
  onSaved: (theme: ThemeDefinition) => void
}): JSX.Element {
  const { editing, seed } = request
  const [name, setName] = useState(request.seedName)
  const [appearance, setAppearance] = useState<ThemeAppearance>(request.appearance)
  const [error, setError] = useState<string | null>(null)
  const [seeds, setSeeds] = useState<Record<ThemeAppearance, Seeds>>(() => ({
    light: seedsFor(seed, "light"),
    dark: seedsFor(seed, "dark"),
  }))
  /**
   * Which appearances this theme will ship. Visiting a half counts as claiming
   * it: the editor has just shown you that palette full-screen, so saving it is
   * less surprising than silently discarding it.
   */
  const [claimed, setClaimed] = useState<ReadonlyArray<ThemeAppearance>>(() =>
    editing ? [...new Set([request.appearance, ...getThemeModes(editing)])] : [request.appearance],
  )

  const active = seeds[appearance]
  const colors = useMemo(
    () => createManagedThemeColors(appearance, active.background, active.accent),
    [appearance, active.accent, active.background],
  )

  // The whole app wears the draft while the dialog is open, which is the only
  // honest way to judge a background against real text at real sizes.
  useEffect(() => {
    applyThemeColorPreview(colors, appearance)
  }, [appearance, colors])

  const setSeed = useCallback(
    (patch: Partial<Seeds>) => {
      setSeeds((current) => ({ ...current, [appearance]: { ...current[appearance], ...patch } }))
    },
    [appearance],
  )

  const chooseAppearance = useCallback((next: ThemeAppearance) => {
    setAppearance(next)
    setClaimed((current) => (current.includes(next) ? current : [...current, next]))
  }, [])

  const save = (): void => {
    const label = name.trim()
    if (label.length === 0) {
      setError("Name your theme first.")
      return
    }
    const other: ThemeAppearance = appearance === "light" ? "dark" : "light"
    const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {}
    if (claimed.includes(other)) {
      variants[other] = createManagedThemeColors(other, seeds[other].background, seeds[other].accent)
    }
    const definition: ThemeDefinition = {
      id: editing ? editing.id : uniqueThemeId(themeIdFromName(label)),
      label,
      appearance,
      colors,
      ...(Object.keys(variants).length > 0 ? { variants } : {}),
      managed: true,
    }
    try {
      onSaved(editing ? updateCustomTheme(definition) : installCustomTheme(definition))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The theme could not be saved.")
    }
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title={editing ? `Edit ${editing.label}` : "Create a theme"}
      description="Pick a background and an accent. Observer derives the rest of the palette from them, keeping text, borders and surfaces readable against each other."
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            {editing ? "Save theme" : "Create theme"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 pb-2">
        <div className="grid gap-1.5">
          <label className="text-sm font-medium text-foreground" htmlFor="theme-editor-name">
            Name
          </label>
          <Input
            id="theme-editor-name"
            inputSize="sm"
            autoFocus
            value={name}
            placeholder="e.g. Aurora"
            onChange={(event) => {
              setName(event.currentTarget.value)
              // Most save failures are about the name; retyping is the fix, so
              // the stale message goes with the old name.
              setError(null)
            }}
          />
        </div>

        <div className="grid gap-1.5">
          <span className="text-sm font-medium text-foreground">Appearance</span>
          <div className="grid grid-cols-2 gap-2">
            {APPEARANCES.map((option) => {
              const selected = option === appearance
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => chooseAppearance(option)}
                  className={cn(
                    "flex cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    selected
                      ? "border-transparent bg-accent/30 text-foreground"
                      : "border-border/70 bg-card/60 text-muted-foreground hover:bg-accent/10",
                  )}
                  style={selected ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
                >
                  {option === "light" ? "Light" : "Dark"}
                </button>
              )
            })}
          </div>
          <p className="text-xs text-muted-foreground/80">
            {claimed.length > 1
              ? "This theme ships both palettes, so one card covers light and dark."
              : "Switch to the other side to give this theme a second palette."}
          </p>
        </div>

        <ColorField
          label="Background"
          description="The canvas behind everything. The sidebar, panels and code surfaces are mixed from it."
          value={active.background}
          onChange={(hex) => setSeed({ background: hex })}
        />
        <ColorField
          label="Accent"
          description="Selection, focus rings and primary buttons. It is nudged to stay readable on the background you chose."
          value={active.accent}
          onChange={(hex) => setSeed({ accent: hex })}
        />

        {error !== null ? (
          <p role="alert" className="rounded-lg bg-error-surface px-3 py-2 text-[13px] text-error-foreground">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}

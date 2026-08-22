/**
 * A typography row: family, size, and a line of text in the result.
 *
 * T3 Code previews the real surfaces — it mounts an actual Lexical composer, an
 * actual Ghostty canvas, an actual rendered diff — so the row is guaranteed to
 * match what ships. Observer has no equivalent surface to borrow inside the
 * settings page, so the preview is a plain line rendered through the same font
 * stack `applyAppearance` writes to `--font-sans` / `--font-mono`. It shows the
 * family and the size honestly; it does not show ligatures in context.
 *
 * The family picker is a list *and* a text field on purpose. The Local Font
 * Access API is Chromium-only and permission-gated, so `discoverInstalledFonts`
 * returning nothing is the common case rather than a failure — and the user who
 * cares most about this row is the one with a font the list would never have.
 */

import { TriangleAlertIcon } from "lucide-react"
import { Badge, DraftInput, Select, type SelectOption } from "../../ui/primitives"
import { isFontFamilyAvailable, BUNDLED_FONTS } from "../../theme/appearance"

const SYSTEM_DEFAULT = ""

/** Quotes a family name so `JetBrains Mono` survives as a single token. */
function previewStack(family: string, fallback: string): string {
  const trimmed = family.trim()
  return trimmed.length === 0 ? fallback : `"${trimmed}", ${fallback}`
}

export function FontFamilySelect({
  family,
  installedFonts,
  ariaLabel,
  onChange,
}: {
  family: string
  installedFonts: ReadonlyArray<string>
  ariaLabel: string
  onChange: (family: string) => void
}): JSX.Element {
  const options: Array<SelectOption<string>> = [{ value: SYSTEM_DEFAULT, label: "System default" }]
  for (const bundled of BUNDLED_FONTS) options.push({ value: bundled, label: bundled, group: "Bundled" })
  for (const installed of installedFonts) {
    if (!options.some((option) => option.value === installed)) {
      options.push({ value: installed, label: installed, group: "Installed" })
    }
  }
  // A family typed by hand, or inherited from another machine, still has to be
  // selectable — otherwise the trigger would fall back to the placeholder and
  // claim nothing is set.
  if (family.length > 0 && !options.some((option) => option.value === family)) {
    options.push({ value: family, label: family, group: "Custom" })
  }

  return <Select value={family} options={options} ariaLabel={ariaLabel} onValueChange={onChange} />
}

export function FontSizeSelect({
  size,
  min,
  max,
  ariaLabel,
  onChange,
}: {
  size: number
  min: number
  max: number
  ariaLabel: string
  onChange: (size: number) => void
}): JSX.Element {
  const options = Array.from({ length: max - min + 1 }, (_, index) => {
    const value = min + index
    return { value: String(value), label: `${value} px` }
  })
  return (
    <div className="w-24 shrink-0">
      <Select
        value={String(size)}
        options={options}
        ariaLabel={ariaLabel}
        onValueChange={(next) => onChange(Number(next))}
      />
    </div>
  )
}

export function FontPreview({
  family,
  fallbackStack,
  size,
  mono,
  text,
}: {
  family: string
  fallbackStack: string
  size: number
  mono: boolean
  text: string
}): JSX.Element {
  return (
    <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5">
      <p
        className="truncate leading-[1.5] text-foreground"
        style={{ fontFamily: previewStack(family, fallbackStack), fontSize: `${size}px` }}
      >
        {text}
      </p>
      <p className="pt-1 text-[11px] text-muted-foreground/70">
        {family.trim().length === 0 ? "System default" : family.trim()} · {size} px
        {mono ? " · monospace" : ""}
      </p>
    </div>
  )
}

export function FontFamilyField({
  family,
  ariaLabel,
  onChange,
}: {
  family: string
  ariaLabel: string
  onChange: (family: string) => void
}): JSX.Element {
  const missing = !isFontFamilyAvailable(family)
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1 sm:max-w-64">
        <DraftInput
          inputSize="sm"
          value={family}
          placeholder="Or type a family name"
          aria-label={ariaLabel}
          onCommit={(next) => onChange(next.trim())}
        />
      </div>
      {missing ? (
        <Badge variant="warning">
          <TriangleAlertIcon className="size-3" />
          Not installed — the fallback stack renders instead
        </Badge>
      ) : null}
    </div>
  )
}

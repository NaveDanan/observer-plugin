/**
 * One theme in the library grid: its light and dark preview balls, its name,
 * and whatever the theme lets you do to it.
 *
 * T3 Code's ball is a blurred radial glow built from three roles. Observer's is
 * a hard-edged stack of seven role swatches instead — sidebar through message
 * action — because the glow reads as "a mood" and the stack reads as "these are
 * the colours", and this grid is the only place in the app where a user is
 * comparing palettes side by side rather than living inside one.
 *
 * Clicking a ball assigns the theme to that appearance alone. That is the whole
 * point of the two-ball card: light and dark are separately owned, so a mix like
 * Grove-by-day / Ocean-by-night needs no extra surface to express.
 */

import { CopyIcon, MoonIcon, PenLineIcon, SunIcon, Trash2Icon, UploadIcon } from "lucide-react"
import { Button, Tooltip } from "../../ui/primitives"
import { cn } from "../../lib/utils"
import type { ThemeAppearance, ThemeColorRole, ThemeDefinition } from "../../theme/palettes"
import { getThemeModes, themeSwatch } from "../../theme/library"

/**
 * The roles a ball paints, ordered from the furthest-back surface to the
 * loudest accent, so every ball is read the same way: chrome on the left,
 * brand on the right.
 */
const BALL_ROLES: ReadonlyArray<ThemeColorRole> = [
  "sidebar",
  "canvas",
  "surface",
  "accentSurface",
  "accent",
  "messageSurface",
  "messageAction",
]

function ballBackground(theme: ThemeDefinition, appearance: ThemeAppearance): string {
  const band = 100 / BALL_ROLES.length
  const stops = BALL_ROLES.map(
    (role, index) => `${themeSwatch(theme, appearance, role)} ${index * band}% ${(index + 1) * band}%`,
  )
  return `linear-gradient(135deg, ${stops.join(", ")})`
}

function ThemeBall({
  theme,
  appearance,
  isActive,
  onSelect,
}: {
  theme: ThemeDefinition
  appearance: ThemeAppearance
  isActive: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    // Below the ball, not above: the card clips its overflow, and a tooltip
    // hanging off the top edge of the grid would never be seen.
    <Tooltip side="bottom" label={appearance === "light" ? "Use for light mode only" : "Use for dark mode only"}>
      <button
        type="button"
        aria-pressed={isActive}
        aria-label={`Use ${theme.label} for ${appearance} mode`}
        onClick={(event) => {
          event.stopPropagation()
          onSelect()
        }}
        className={cn(
          "relative flex size-[68px] shrink-0 cursor-pointer items-center justify-center rounded-full p-1 outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
          isActive && "hover:scale-100",
        )}
      >
        <span
          aria-hidden="true"
          className="block size-14 shrink-0 rounded-full border-2 border-background shadow-sm"
          style={{ backgroundImage: ballBackground(theme, appearance) }}
        />
        {isActive ? (
          <>
            <span aria-hidden="true" className="pointer-events-none absolute inset-1 rounded-full ring-2 ring-ring" />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-0.5 right-0.5 flex size-5 items-center justify-center rounded-full border border-border/70 bg-background text-foreground shadow-sm"
            >
              {appearance === "light" ? <SunIcon className="size-3" /> : <MoonIcon className="size-3" />}
            </span>
          </>
        ) : null}
      </button>
    </Tooltip>
  )
}

export function ThemeLibraryCard({
  theme,
  isActive,
  activeAppearances,
  onUse,
  onUseAppearance,
  onDuplicate,
  onExport,
  onEdit,
  onRemove,
}: {
  theme: ThemeDefinition
  /** The theme owns both halves outright, not just one of them. */
  isActive: boolean
  activeAppearances: ReadonlyArray<ThemeAppearance>
  onUse: () => void
  onUseAppearance: (appearance: ThemeAppearance) => void
  onDuplicate: () => void
  onExport: () => void
  /** Absent for stock and built-in themes: they are not the user's to change. */
  onEdit?: () => void
  onRemove?: () => void
}): JSX.Element {
  const modes = getThemeModes(theme)
  const useLabel =
    modes.length > 1 ? "Use for both light and dark" : `Use for ${modes[0] ?? theme.appearance} mode only`

  return (
    <div
      data-theme-library-card={theme.id}
      onClick={onUse}
      className={cn(
        "cursor-pointer overflow-hidden rounded-xl border border-border/70 bg-card/60 transition-colors hover:bg-accent/10",
        isActive && "bg-accent/30",
      )}
      style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
    >
      <div className="flex min-h-16 items-center justify-center gap-2.5 px-3 pt-3">
        {modes.map((appearance) => (
          <ThemeBall
            key={appearance}
            theme={theme}
            appearance={appearance}
            isActive={activeAppearances.includes(appearance)}
            onSelect={() => onUseAppearance(appearance)}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 px-3 pb-3 pt-2">
        <div className="min-w-0 flex-1">
          <Tooltip label={useLabel}>
            <button
              type="button"
              aria-pressed={isActive}
              aria-label={`Use the ${theme.label} theme${isActive ? ", currently active" : ""}`}
              onClick={(event) => {
                event.stopPropagation()
                onUse()
              }}
              className="min-w-0 max-w-full cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            >
              {theme.label}
            </button>
          </Tooltip>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip label="Duplicate theme">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Duplicate ${theme.label}`}
              onClick={(event) => {
                event.stopPropagation()
                onDuplicate()
              }}
            >
              <CopyIcon />
            </Button>
          </Tooltip>
          {onEdit ? (
            <Tooltip label="Edit theme">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Edit ${theme.label}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onEdit()
                }}
              >
                <PenLineIcon />
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip label="Export theme file">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Export ${theme.label}`}
              onClick={(event) => {
                event.stopPropagation()
                onExport()
              }}
            >
              <UploadIcon />
            </Button>
          </Tooltip>
          {onRemove ? (
            <Tooltip label="Remove theme">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${theme.label}`}
                className="text-muted-foreground hover:text-destructive"
                onClick={(event) => {
                  event.stopPropagation()
                  onRemove()
                }}
              >
                <Trash2Icon />
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </div>
  )
}

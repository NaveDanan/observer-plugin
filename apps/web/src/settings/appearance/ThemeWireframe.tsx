/**
 * The miniature app window that fills each appearance tile.
 *
 * Ported from T3 Code's `ThemeWireframe`, with Observer's furniture in place of
 * a chat transcript: sidebar rail, topbar, agent nodes on the canvas, and the
 * detail panel docked to the right. The geometry is entirely percentage based,
 * so the same component serves the 8.75rem tile and anything else that asks.
 *
 * T3 Code paints the hairlines and the status dots with fixed greys and greens.
 * Those are the two places a preview can quietly lie — a theme that tints its
 * borders would show someone else's — so every value here is derived from the
 * palette being previewed, and nothing in this file is a colour literal.
 */

import { cn } from "../../lib/utils"
import type { ThemeColors } from "../../theme/palettes"

/** A hairline that follows the palette instead of a fixed grey. */
function hairline(colors: ThemeColors): string {
  return `color-mix(in srgb, ${colors.border} 78%, transparent)`
}

/** The stand-in for text, faint enough to read as a line rather than a bar. */
function textLine(colors: ThemeColors): string {
  return `color-mix(in srgb, ${colors.textMuted} 42%, transparent)`
}

export function ThemeWireframePane({
  colors,
  clip,
}: {
  colors: ThemeColors
  /** Half of a split tile: the System preview lays a light pane over a dark one. */
  clip?: "left" | "right"
}): JSX.Element {
  const line = hairline(colors)
  const text = textLine(colors)
  return (
    <span
      className="absolute inset-0"
      style={
        clip === undefined
          ? undefined
          : {
              clipPath:
                clip === "left"
                  ? "polygon(0 0, calc(50% - 1px) 0, calc(50% - 1px) 100%, 0 100%)"
                  : "polygon(calc(50% + 1px) 0, 100% 0, 100% 100%, calc(50% + 1px) 100%)",
            }
      }
    >
      <span className="absolute inset-0" style={{ backgroundColor: colors.canvas }} />

      {/* Sidebar rail: search field, then the session rows */}
      <span
        className="absolute inset-y-0 left-0 w-[22%]"
        style={{ backgroundColor: colors.sidebar, boxShadow: `inset -1px 0 0 ${colors.sidebarBorder}` }}
      />
      <span
        className="absolute left-[3%] top-[7%] h-[8%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.sidebarControlSurface, boxShadow: `inset 0 0 0 1px ${line}` }}
      />
      <span
        className="absolute left-[3%] top-[21%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.sidebarRowSelected }}
      />
      <span
        className="absolute left-[3%] top-[31%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.sidebarRowHover }}
      />
      <span
        className="absolute left-[3%] top-[41%] h-[7%] w-[16%] rounded-md"
        style={{ backgroundColor: colors.sidebarRowHover, opacity: 0.55 }}
      />

      {/* Topbar over the canvas */}
      <span
        className="absolute left-[22%] right-0 top-0 flex h-[13%] items-center justify-between px-[2%]"
        style={{ backgroundColor: colors.toolbar, boxShadow: `inset 0 -1px 0 ${colors.toolbarBorder}` }}
      >
        <span className="block h-[26%] w-[26%] rounded-full" style={{ backgroundColor: text }} />
        <span
          className="block h-[46%] w-[14%] rounded-md"
          style={{ backgroundColor: colors.toolbarControl, boxShadow: `inset 0 0 0 1px ${line}` }}
        />
      </span>

      {/* Agent nodes on the canvas, one of them selected */}
      {[
        { top: "24%", left: "27%", width: "24%", dot: colors.messageAction },
        { top: "48%", left: "31%", width: "22%", dot: colors.accent },
        { top: "72%", left: "27%", width: "20%", dot: colors.warning },
      ].map((node) => (
        <span
          className="absolute flex h-[15%] items-center gap-[6%] rounded-lg px-[3%]"
          key={node.top}
          style={{
            top: node.top,
            left: node.left,
            width: node.width,
            backgroundColor: colors.surfaceRaised,
            boxShadow: `inset 0 0 0 1px ${line}`,
          }}
        >
          <span className="block aspect-square h-[34%] rounded-full" style={{ backgroundColor: node.dot }} />
          <span className="block h-[22%] w-[56%] rounded-full" style={{ backgroundColor: text }} />
        </span>
      ))}

      {/* Detail panel docked over the canvas, with its accent header */}
      <span
        className="absolute right-[4%] top-[19%] h-[62%] w-[20%] overflow-hidden rounded-lg shadow-sm"
        style={{ backgroundColor: colors.surfaceOverlay, boxShadow: `inset 0 0 0 1px ${line}` }}
      >
        <span
          className="absolute inset-x-0 top-0 h-[22%]"
          style={{ backgroundColor: colors.accentSurface, boxShadow: `inset 0 -1px 0 ${line}` }}
        />
        {[0, 1, 2].map((row) => (
          <span
            className="absolute left-[12%] right-[12%] rounded-full"
            key={row}
            style={{
              top: `${34 + row * 20}%`,
              height: "8%",
              backgroundColor: row === 0 ? colors.messageSurface : text,
            }}
          />
        ))}
      </span>
    </span>
  )
}

export function ThemeWireframe({
  className,
  panes,
}: {
  /** Sizing only — the pane geometry inside is percentage based. */
  className?: string
  panes: ReadonlyArray<{ colors: ThemeColors; clip?: "left" | "right" }>
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn("relative block w-full overflow-hidden rounded-lg border border-border/60", className)}
    >
      {panes.map((pane) => (
        <ThemeWireframePane key={pane.clip ?? "pane"} colors={pane.colors} {...(pane.clip ? { clip: pane.clip } : {})} />
      ))}
    </span>
  )
}

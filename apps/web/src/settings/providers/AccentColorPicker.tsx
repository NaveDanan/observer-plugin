/**
 * The accent swatch picker.
 *
 * T3 Code opens its own HSV plane in a popover; Observer uses the platform's
 * `<input type="color">` instead. The picker is a once-in-a-while control, and
 * a native one costs nothing to ship, is keyboard- and screen-reader-native,
 * and is the only colour surface here users already know.
 *
 * Every change is debounced before it reaches the caller: dragging inside the
 * OS colour wheel fires `change` continuously, and each of those would
 * otherwise be a `PUT /v1/config`.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { XIcon } from "lucide-react"
import { Button } from "../../ui/primitives"
import { cn } from "../../lib/utils"
import { ACCENT_SWATCHES, normalizeAccentColor } from "./instances"

const FALLBACK_SWATCH = ACCENT_SWATCHES[0] ?? "#2563eb"

export function AccentColorPicker({
  displayName,
  value,
  onCommit,
  description,
  commitDelayMs = 150,
}: {
  displayName: string
  value: string | undefined
  onCommit: (value: string) => void
  description?: string
  commitDelayMs?: number
}): JSX.Element {
  const [draft, setDraft] = useState(() => normalizeAccentColor(value) ?? "")
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<string | null>(null)
  const onCommitRef = useRef(onCommit)

  useEffect(() => {
    onCommitRef.current = onCommit
  }, [onCommit])

  // While a commit is in flight the daemon's copy is behind the swatch the
  // user is looking at, so the prop is only adopted when nothing is pending.
  useEffect(() => {
    if (pendingRef.current !== null) return
    setDraft(normalizeAccentColor(value) ?? "")
  }, [value])

  // Unmounting mid-drag (collapsing the card, closing the dialog) must not
  // throw the last colour away.
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending !== null) onCommitRef.current(pending)
    }
  }, [])

  const commit = useCallback(
    (next: string) => {
      const normalized = normalizeAccentColor(next) ?? ""
      setDraft(normalized)
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
      if (commitDelayMs <= 0) {
        pendingRef.current = null
        onCommitRef.current(normalized)
        return
      }
      pendingRef.current = normalized
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null
        const pending = pendingRef.current
        pendingRef.current = null
        if (pending !== null) onCommitRef.current(pending)
      }, commitDelayMs)
    },
    [commitDelayMs],
  )

  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-foreground">Accent colour</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          type="color"
          value={draft || FALLBACK_SWATCH}
          onChange={(event) => commit(event.currentTarget.value)}
          aria-label={`Custom accent colour for ${displayName}`}
          className="h-8 w-10 cursor-pointer rounded-xl border border-input bg-background p-0.5"
        />
        <div className="flex flex-wrap gap-1.5">
          {ACCENT_SWATCHES.map((swatch) => {
            const selected = draft === swatch
            return (
              <button
                key={swatch}
                type="button"
                aria-pressed={selected}
                aria-label={`Use ${swatch} accent for ${displayName}`}
                onClick={() => commit(selected ? "" : swatch)}
                style={{ backgroundColor: swatch }}
                className={cn(
                  "size-6 cursor-pointer rounded-full border outline-none transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  selected
                    ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                    : "border-black/10 hover:scale-105 dark:border-white/20",
                )}
              />
            )
          })}
        </div>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          onClick={() => commit("")}
          aria-label={`Clear accent colour for ${displayName}`}
          className={cn("shrink-0 transition-opacity", draft ? "opacity-100" : "pointer-events-none opacity-0")}
          tabIndex={draft ? 0 : -1}
          aria-hidden={draft ? undefined : true}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
    </div>
  )
}

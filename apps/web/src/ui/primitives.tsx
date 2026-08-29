/**
 * The interface primitives.
 *
 * These are T3 Code's controls rebuilt on plain React: the class strings are
 * carried across verbatim from its `components/ui/*` so a button, switch or
 * input renders pixel-for-pixel the same, but the behaviour underneath is
 * hand-rolled rather than Base UI. Observer ships one 300 kB canvas bundle
 * already; a headless component library for eleven controls is not a trade
 * this app needs to make.
 *
 * Anything that needs to escape its parent's overflow (the select popup, the
 * dialog) portals to `document.body`.
 */

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { ChevronDownIcon, CheckIcon, MinusIcon, PlusIcon, Undo2Icon, XIcon } from "lucide-react"
import { cn } from "../lib/utils"

/* ------------------------------------------------------------------ button */

export type ButtonVariant =
  | "default"
  | "destructive"
  | "destructive-outline"
  | "ghost"
  | "ghost-muted"
  | "outline"
  | "secondary"
export type ButtonSize = "default" | "sm" | "xs" | "compact" | "icon" | "icon-sm" | "icon-xs" | "icon-micro"

const BUTTON_BASE =
  "[--control-icon-color:currentColor] [&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-base outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 sm:text-sm [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default:
    "not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-primary bg-primary text-primary-foreground shadow-primary/24 shadow-xs hover:bg-primary/90 active:shadow-none",
  destructive:
    "not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-destructive bg-destructive text-white shadow-destructive/24 shadow-xs hover:bg-destructive/90 active:shadow-none",
  "destructive-outline":
    "border-input bg-popover not-dark:bg-clip-padding text-destructive-foreground shadow-xs/5 hover:border-destructive/32 hover:bg-destructive/4 dark:bg-input/32",
  ghost:
    "[--control-icon-color:var(--muted-foreground)] border-transparent text-foreground hover:bg-accent",
  "ghost-muted":
    "[--control-icon-color:var(--muted-foreground)] border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
  outline:
    "[--control-icon-color:var(--muted-foreground)] border-input bg-popover not-dark:bg-clip-padding text-foreground shadow-xs/5 hover:bg-accent/50 dark:bg-input/32 dark:hover:bg-input/64",
  secondary:
    "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/90 active:bg-secondary/80",
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
  sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
  xs: "h-7 gap-1 px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
  compact:
    "h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-xs before:rounded-[calc(var(--radius-md)-1px)] [&_svg:not([class*='size-'])]:size-3.5",
  icon: "size-9 sm:size-8",
  "icon-sm": "size-8 sm:size-7",
  "icon-xs":
    "size-7 sm:size-6 [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
  "icon-micro":
    "size-5 rounded-sm p-0 before:rounded-[calc(var(--radius-sm)-1px)] [&_svg:not([class*='size-'])]:size-3",
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

export function Button({ className, variant = "default", size = "default", type, ...props }: ButtonProps): JSX.Element {
  return (
    <button
      type={type ?? "button"}
      data-slot="button"
      className={cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      {...props}
    />
  )
}

/* ------------------------------------------------------------------- input */

const INPUT_SHELL =
  "relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow has-focus-visible:border-ring has-focus-visible:ring-[3px] has-disabled:opacity-64 sm:text-sm dark:bg-input/32"

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  inputSize?: "default" | "compact" | "sm"
  unstyled?: boolean
}

/**
 * `forwardRef` rather than a plain `ref` prop: this app is on React 18, where
 * a function component never receives `ref` as a prop, and the settings search
 * field needs the node to focus it from a keyboard shortcut.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, inputSize = "default", unstyled = false, ...props },
  ref,
): JSX.Element {
  const field = (
    <input
      ref={ref}
      data-slot="input"
      className={cn(
        "h-8.5 w-full min-w-0 rounded-[inherit] bg-transparent px-[calc(--spacing(3)-1px)] leading-8.5 outline-none placeholder:text-placeholder sm:h-7.5 sm:leading-7.5",
        inputSize === "compact" && "h-7 px-[calc(--spacing(2.5)-1px)] text-xs leading-7 sm:h-7 sm:leading-7",
        inputSize === "sm" && "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5",
        props.type === "search" &&
          "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none",
      )}
      {...props}
    />
  )
  if (unstyled) return field
  return (
    <span
      data-slot="input-control"
      className={cn(INPUT_SHELL, inputSize === "compact" && "rounded-md", className)}
    >
      {field}
    </span>
  )
})

/**
 * An input that only reports a value once the user is done with it.
 *
 * Settings write through to the daemon, so committing on every keystroke would
 * mean a request per character. This commits on blur and on Enter, and drops
 * the draft on Escape.
 */
export function DraftInput({
  value,
  onCommit,
  ...props
}: Omit<InputProps, "value" | "onChange"> & { value: string; onCommit: (value: string) => void }): JSX.Element {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [editing, value])

  return (
    <Input
      {...props}
      value={draft}
      onChange={(event) => {
        setEditing(true)
        setDraft(event.currentTarget.value)
      }}
      onBlur={(event) => {
        setEditing(false)
        if (draft !== value) onCommit(draft)
        props.onBlur?.(event)
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur()
        } else if (event.key === "Escape") {
          setDraft(value)
          setEditing(false)
          event.currentTarget.blur()
        }
        props.onKeyDown?.(event)
      }}
    />
  )
}

/* ------------------------------------------------------------------ switch */

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      data-slot="switch"
      data-checked={checked ? "" : undefined}
      data-unchecked={checked ? undefined : ""}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex h-[calc(var(--thumb-size)+2px)] w-[calc(var(--thumb-size)*2-2px)] shrink-0 cursor-pointer items-center rounded-full p-px outline-none transition-[background-color,box-shadow] duration-200 [--thumb-size:--spacing(5)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input disabled:cursor-not-allowed disabled:opacity-64 sm:[--thumb-size:--spacing(4)]",
        className,
      )}
      {...props}
    >
      <span
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block aspect-square h-full rounded-full bg-background shadow-sm/5 transition-transform duration-150 will-change-transform",
          checked && "translate-x-[calc(var(--thumb-size)-4px)]",
        )}
      />
    </button>
  )
}

/* ---------------------------------------------------------------- checkbox */

export function Checkbox({
  checked,
  onCheckedChange,
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-input bg-background text-primary-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        checked && "border-primary bg-primary",
        className,
      )}
      {...props}
    >
      {checked ? <CheckIcon className="size-3" /> : null}
    </button>
  )
}

/* ------------------------------------------------------------------- badge */

export function Badge({
  variant = "default",
  size = "default",
  className,
  children,
}: {
  variant?: "default" | "secondary" | "outline" | "warning" | "error" | "success"
  size?: "default" | "sm"
  className?: string
  children: ReactNode
}): JSX.Element {
  const variants: Record<string, string> = {
    default: "border-transparent bg-primary/12 text-primary",
    secondary: "border-transparent bg-secondary text-secondary-foreground",
    outline: "border-border/70 text-muted-foreground",
    warning: "border-transparent bg-warning-surface text-warning-foreground",
    error: "border-transparent bg-error-surface text-error-foreground",
    success: "border-transparent bg-success/12 text-success-foreground",
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium",
        size === "sm" ? "text-[10px]" : "text-xs",
        variants[variant],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Kbd({ className, children }: { className?: string; children: ReactNode }): JSX.Element {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border/70 bg-muted px-1 font-mono text-[10px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/* ------------------------------------------------------------------ select */

export interface SelectOption<T extends string> {
  value: T
  label: string
  /** Optional group heading; consecutive options with the same group merge. */
  group?: string
  disabled?: boolean
}

/**
 * A listbox with a portalled popup.
 *
 * Native `<select>` would be less code, but its popup is drawn by the OS and
 * would be the one surface in the app that ignores the theme entirely.
 */
export function Select<T extends string>({
  value,
  options,
  onValueChange,
  placeholder = "Select…",
  disabled,
  className,
  ariaLabel,
}: {
  value: T | undefined
  options: ReadonlyArray<SelectOption<T>>
  onValueChange: (value: T) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  ariaLabel?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selected = options.find((option) => option.value === value)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "inline-flex h-8 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-[var(--control-radius)] border border-input bg-popover px-[calc(--spacing(2.5)-1px)] text-sm text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 disabled:pointer-events-none disabled:opacity-64 sm:h-7 dark:bg-input/32",
          className,
        )}
      >
        <span className={cn("truncate", !selected && "text-placeholder")}>{selected?.label ?? placeholder}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open ? (
        <Popup anchor={triggerRef.current} onClose={() => setOpen(false)} matchAnchorWidth>
          <div role="listbox" className="max-h-72 overflow-y-auto p-1">
            {options.map((option, index) => {
              const heading = option.group && option.group !== options[index - 1]?.group ? option.group : null
              return (
                <div key={option.value}>
                  {heading ? (
                    <div className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
                      {heading}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    onClick={() => {
                      onValueChange(option.value)
                      setOpen(false)
                    }}
                    className={cn(
                      "flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground outline-none hover:bg-accent disabled:pointer-events-none disabled:opacity-64",
                      option.value === value && "bg-accent/60",
                    )}
                  >
                    <span className="truncate">{option.label}</span>
                    {option.value === value ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
                  </button>
                </div>
              )
            })}
            {options.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">Nothing to choose from</p>
            ) : null}
          </div>
        </Popup>
      ) : null}
    </>
  )
}

/**
 * A popup anchored under a trigger, closed by Escape, an outside click or a
 * scroll. Positioned fixed so a panel's `overflow: hidden` cannot clip it.
 */
export function Popup({
  anchor,
  onClose,
  matchAnchorWidth = false,
  className,
  children,
}: {
  anchor: HTMLElement | null
  onClose: () => void
  matchAnchorWidth?: boolean
  className?: string
  children: ReactNode
}): JSX.Element | null {
  const [style, setStyle] = useState<{ top: number; left: number; width?: number; maxHeight: number } | null>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!anchor) return
    const place = (): void => {
      const rect = anchor.getBoundingClientRect()
      const below = window.innerHeight - rect.bottom - 12
      const above = rect.top - 12
      const openUp = below < 200 && above > below
      setStyle({
        top: openUp ? Math.max(8, rect.top - Math.min(above, 320) - 6) : rect.bottom + 6,
        left: Math.min(rect.left, window.innerWidth - (matchAnchorWidth ? rect.width : 240) - 8),
        width: matchAnchorWidth ? rect.width : undefined,
        maxHeight: Math.max(160, openUp ? above : below),
      })
    }
    place()
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [anchor, matchAnchorWidth])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (popupRef.current?.contains(target) || anchor?.contains(target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [anchor, onClose])

  if (!style) return null
  return createPortal(
    <div
      ref={popupRef}
      data-slot="popup"
      style={{ top: style.top, left: style.left, width: style.width, maxHeight: style.maxHeight }}
      className={cn(
        "dropdown-glass fixed z-50 min-w-40 overflow-hidden rounded-xl shadow-[0_24px_64px_-24px_rgb(0_0_0/45%)]",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ dialog */

export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  footer?: ReactNode
  className?: string
  children?: ReactNode
}): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    // Focus the panel so Escape and Tab start inside the dialog.
    panelRef.current?.focus()
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose, open])

  if (!open) return null
  return createPortal(
    <div className="dialog-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="dialog-backdrop absolute inset-0" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "dialog-panel",
          "dialog-glass relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border outline-none",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
          <div className="min-w-0 space-y-1">
            <h2 id={titleId} className="text-base font-semibold tracking-[-0.01em] text-foreground">
              {title}
            </h2>
            {description ? <p className="text-[13px] text-muted-foreground">{description}</p> : null}
          </div>
          <Button size="icon-sm" variant="ghost-muted" aria-label="Close" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        <div className="dialog-body min-h-0 flex-1 overflow-y-auto px-5 pb-2">{children}</div>
        {footer ? <div className="dialog-footer flex items-center justify-end gap-2 px-5 pt-3 pb-5">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------- number field */

export function NumberField({
  value,
  onValueChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  suffix,
  ariaLabel,
  className,
}: {
  value: number
  onValueChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
  ariaLabel?: string
  className?: string
}): JSX.Element {
  const clamp = (next: number): number => Math.min(max, Math.max(min, next))
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="inline-flex h-8 items-center rounded-[var(--control-radius)] border border-input bg-popover shadow-xs/5 sm:h-7 dark:bg-input/32">
        <button
          type="button"
          aria-label="Decrease"
          onClick={() => onValueChange(clamp(value - step))}
          disabled={value <= min}
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-l-[var(--control-radius)] text-muted-foreground outline-none hover:text-foreground disabled:pointer-events-none disabled:opacity-50 sm:size-6"
        >
          <MinusIcon className="size-3.5" />
        </button>
        <input
          type="number"
          aria-label={ariaLabel}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => {
            const next = Number.parseInt(event.currentTarget.value, 10)
            if (Number.isFinite(next)) onValueChange(clamp(next))
          }}
          className="h-full w-14 min-w-0 border-x border-input bg-transparent text-center font-mono text-xs text-foreground tabular-nums outline-none [appearance:textfield] focus-visible:bg-accent/40 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <button
          type="button"
          aria-label="Increase"
          onClick={() => onValueChange(clamp(value + step))}
          disabled={value >= max}
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-r-[var(--control-radius)] text-muted-foreground outline-none hover:text-foreground disabled:pointer-events-none disabled:opacity-50 sm:size-6"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      {suffix ? <span className="text-xs text-muted-foreground">{suffix}</span> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ slider */

export function Slider({
  value,
  onValueChange,
  min,
  max,
  step,
  ariaLabel,
  className,
}: {
  value: number
  onValueChange: (value: number) => void
  min: number
  max: number
  step: number
  ariaLabel?: string
  className?: string
}): JSX.Element {
  const progress = ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      aria-label={ariaLabel}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(event) => onValueChange(Number(event.currentTarget.value))}
      style={{ ["--settings-slider-progress" as string]: `${progress}%` }}
      className={cn("settings-slider w-40", className)}
    />
  )
}

/* ----------------------------------------------------------------- tooltip */

/**
 * A hover/focus label. Deliberately simple: it renders in place with
 * `position: absolute`, so it is only used on controls that are not inside a
 * clipping scroll container.
 */
export function Tooltip({
  label,
  side = "top",
  children,
}: {
  label: ReactNode
  side?: "top" | "bottom"
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open ? (
        <span
          role="tooltip"
          className={cn(
            "dropdown-glass pointer-events-none absolute left-1/2 z-50 w-max max-w-64 -translate-x-1/2 rounded-lg px-2 py-1 text-xs text-popover-foreground shadow-lg",
            side === "top" ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]",
          )}
        >
          {label}
        </span>
      ) : null}
    </span>
  )
}

/* -------------------------------------------------------------- collapsible */

export function Collapsible({ open, children }: { open: boolean; children: ReactNode }): JSX.Element | null {
  if (!open) return null
  return <div className="overflow-hidden">{children}</div>
}

/* ------------------------------------------------------- settings scaffolding */

interface SettingsSearchTarget {
  targetId: string | null
  onTargetHandled: () => void
}

const SettingsSearchTargetContext = createContext<SettingsSearchTarget>({
  targetId: null,
  onTargetHandled: () => undefined,
})

export function SettingsSearchTargetProvider({
  targetId,
  onTargetHandled,
  children,
}: {
  targetId: string | null
  onTargetHandled: () => void
  children: ReactNode
}): JSX.Element {
  const value = useMemo(() => ({ targetId, onTargetHandled }), [onTargetHandled, targetId])
  return <SettingsSearchTargetContext.Provider value={value}>{children}</SettingsSearchTargetContext.Provider>
}

function useSettingsSearchTarget<T extends HTMLElement>(id: string | undefined): (node: T | null) => void {
  const { targetId, onTargetHandled } = useContext(SettingsSearchTargetContext)
  const isTarget = id !== undefined && id === targetId
  return useCallback(
    (node: T | null) => {
      if (!node || !isTarget) return
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      const scrollTarget = node.tagName === "SECTION" && node.firstElementChild ? (node.firstElementChild as HTMLElement) : node
      scrollTarget.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" })
      node.focus({ preventScroll: true })
      node.classList.remove("settings-search-target-pulse")
      if (!reduced) {
        void node.offsetWidth
        node.classList.add("settings-search-target-pulse")
        node.addEventListener("blur", () => node.classList.remove("settings-search-target-pulse"), { once: true })
      }
      onTargetHandled()
    },
    [isTarget, onTargetHandled],
  )
}

export function SettingsSection({
  id,
  title,
  icon,
  headerAction,
  className,
  children,
}: {
  id?: string
  title: string
  icon?: ReactNode
  headerAction?: ReactNode
  className?: string
  children: ReactNode
}): JSX.Element {
  const targetRef = useSettingsSearchTarget<HTMLElement>(id)
  return (
    <section id={id} ref={targetRef} tabIndex={id ? -1 : undefined} className={cn("space-y-3", className)}>
      <div className="flex min-h-8 items-center justify-between gap-4 px-3 sm:px-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-[-0.025em] text-foreground">
          {icon}
          {title}
        </h2>
        <div className="flex min-h-7 min-w-7 items-center justify-end">{headerAction}</div>
      </div>
      <div className="relative space-y-1 overflow-visible text-foreground">{children}</div>
    </section>
  )
}

export function SettingsRow({
  id,
  title,
  description,
  status,
  resetAction,
  control,
  className,
  children,
}: {
  id?: string
  title: ReactNode
  description?: ReactNode
  status?: ReactNode
  resetAction?: ReactNode
  control?: ReactNode
  className?: string
  children?: ReactNode
}): JSX.Element {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(id)
  return (
    <div
      id={id}
      ref={targetRef}
      tabIndex={id ? -1 : undefined}
      className={cn("rounded-xl px-3 sm:px-4", children ? "pt-3 pb-1" : "py-3", className)}
    >
      <div className="flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] sm:items-center sm:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium tracking-[-0.005em] text-foreground">{title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">{resetAction}</span>
          </div>
          {description ? (
            <p className="max-w-xl text-[13px] leading-[1.45] text-muted-foreground/80">{description}</p>
          ) : null}
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">{control}</div>
        ) : null}
      </div>
      {children}
    </div>
  )
}

export function SettingResetButton({
  label,
  disabled = false,
  onClick,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <Tooltip label="Reset to default">
      <Button
        size="icon-micro"
        variant="ghost-muted"
        aria-label={`Reset ${label} to default`}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation()
          onClick()
        }}
      >
        <Undo2Icon className="size-3" />
      </Button>
    </Tooltip>
  )
}

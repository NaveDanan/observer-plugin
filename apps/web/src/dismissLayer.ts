import { useEffect, useRef, type RefObject } from "react"

/**
 * One Escape key, one layer at a time.
 *
 * The Worker card and the activity panel each bound their own global
 * `keydown` listener and each called `focus()` on mount, and they always
 * mount together — so Escape fired both handlers and whichever effect ran
 * last silently won the focus. That was survivable while two panels shared
 * one close action. It stops being survivable the moment a modal opens on
 * top of them, because Escape would close the modal *and* the panels
 * underneath it in a single keystroke.
 *
 * So dismissal is a stack, not a set of listeners. Layers register in mount
 * order, the last one registered is on top, and only the top one hears
 * Escape. One `keydown` listener serves all of them.
 */

export interface DismissLayer {
  onDismiss: () => void
}

const layers: DismissLayer[] = []
let listening = false

/** Registers a layer. The returned function removes it again. */
export function pushDismissLayer(layer: DismissLayer): () => void {
  layers.push(layer)
  startListening()
  return () => {
    const index = layers.lastIndexOf(layer)
    if (index >= 0) layers.splice(index, 1)
  }
}

/** Dismisses the top layer. Returns false when nothing is open. */
export function dismissTopLayer(): boolean {
  const top = layers[layers.length - 1]
  if (!top) return false
  top.onDismiss()
  return true
}

/** How many layers are open. */
export function dismissLayerCount(): number {
  return layers.length
}

/** Test seam: empties the stack between cases. */
export function __resetDismissLayers(): void {
  layers.length = 0
}

function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return
  // Only swallow the key when a layer actually handled it, so Escape still
  // reaches the canvas when nothing is open.
  if (dismissTopLayer()) event.stopPropagation()
}

function startListening(): void {
  if (listening || typeof window === "undefined") return
  listening = true
  window.addEventListener("keydown", onEscape)
}

export interface DismissLayerOptions {
  /** Focused when the layer opens. The last layer to mount wins. */
  focusRef?: RefObject<HTMLElement | null>
  /**
   * Where focus goes when the layer closes. Only the card modal asks for
   * this: the docked panels close by deselecting the agent, which unmounts
   * the element focus would otherwise be handed back to.
   */
  returnFocus?: () => HTMLElement | null | undefined
}

/**
 * Registers a dismissable layer for the lifetime of the component.
 *
 * Registration happens once per mount. `onDismiss` is read through a ref on
 * every keystroke so a caller passing a fresh arrow function each render
 * does not re-register the layer and reshuffle the stack under itself.
 */
export function useDismissLayer(onDismiss: () => void, options: DismissLayerOptions = {}): void {
  const { focusRef, returnFocus } = options
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  const returnFocusRef = useRef(returnFocus)
  returnFocusRef.current = returnFocus

  useEffect(() => {
    // Captured before this layer takes focus, so it is the element the
    // developer was on when they opened it.
    const previous = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null
    const remove = pushDismissLayer({ onDismiss: () => dismissRef.current() })
    focusRef?.current?.focus()

    return () => {
      remove()
      const resolve = returnFocusRef.current
      if (!resolve) return
      // React detaches this subtree after cleanup runs, so anything inside
      // it would be focused and then immediately thrown away. Prefer the
      // caller's explicit target; fall back to wherever focus came from.
      const target = resolve() ?? (previous?.isConnected ? previous : null)
      target?.focus()
    }
    // Deliberately once per mount: see the doc comment.
  }, [focusRef])
}

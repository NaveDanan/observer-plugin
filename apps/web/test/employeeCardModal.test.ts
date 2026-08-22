import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  __resetDismissLayers,
  dismissLayerCount,
  dismissTopLayer,
  pushDismissLayer,
} from "../src/dismissLayer"
import { __resetForTests, closeEmployeeCard, getState, nextCardAgentId, openEmployeeCard } from "../src/store"

describe("employee card modal state", () => {
  beforeEach(() => {
    __resetForTests()
  })

  it("starts closed", () => {
    expect(getState().cardAgentId).toBeUndefined()
  })

  it("opens over the agent it was raised from", () => {
    openEmployeeCard("claude:s1~a~t:1")
    expect(getState().cardAgentId).toBe("claude:s1~a~t:1")
  })

  it("closes without touching the selection", () => {
    openEmployeeCard("a")
    closeEmployeeCard()
    expect(getState().cardAgentId).toBeUndefined()
  })

  it("keeps the card open when the selection lands back on its own agent", () => {
    // A double-click fires a click first, which selects. If that closed the
    // card, double-click could never open one.
    expect(nextCardAgentId("a", "a")).toBe("a")
  })

  it("closes the card when a different agent is selected", () => {
    // The docked panels follow the new selection, so a card still showing the
    // old employee would be contradicting the panel beside it.
    expect(nextCardAgentId("a", "b")).toBeUndefined()
  })

  it("closes the card when the selection is cleared", () => {
    expect(nextCardAgentId("a", undefined)).toBeUndefined()
  })

  it("stays closed when nothing was open", () => {
    expect(nextCardAgentId(undefined, "a")).toBeUndefined()
  })
})

describe("dismiss layers", () => {
  beforeEach(() => {
    __resetDismissLayers()
  })

  it("does nothing when no layer is open, so Escape reaches the canvas", () => {
    expect(dismissTopLayer()).toBe(false)
  })

  it("dismisses only the top layer", () => {
    // The bug this replaces: the Worker card and the activity panel both bound
    // a global Escape handler and both mount together, so one keystroke fired
    // both. A modal on top would have closed all three.
    const worker = vi.fn()
    const detail = vi.fn()
    const card = vi.fn()
    pushDismissLayer({ onDismiss: worker })
    pushDismissLayer({ onDismiss: detail })
    pushDismissLayer({ onDismiss: card })

    expect(dismissTopLayer()).toBe(true)
    expect(card).toHaveBeenCalledTimes(1)
    expect(detail).not.toHaveBeenCalled()
    expect(worker).not.toHaveBeenCalled()
  })

  it("uncovers the next layer once the top one is removed", () => {
    const under = vi.fn()
    const over = vi.fn()
    pushDismissLayer({ onDismiss: under })
    const removeOver = pushDismissLayer({ onDismiss: over })

    removeOver()
    dismissTopLayer()
    expect(under).toHaveBeenCalledTimes(1)
    expect(over).not.toHaveBeenCalled()
  })

  it("removes the layer it was given, not one that merely looks like it", () => {
    const onDismiss = vi.fn()
    const first = pushDismissLayer({ onDismiss })
    pushDismissLayer({ onDismiss })
    first()
    expect(dismissLayerCount()).toBe(1)
  })

  it("is idempotent when a layer unmounts twice", () => {
    const remove = pushDismissLayer({ onDismiss: vi.fn() })
    remove()
    remove()
    expect(dismissLayerCount()).toBe(0)
  })
})

/**
 * Reading and rewriting host targets.
 *
 * The theme running through all of it is that this is a settings page over a
 * file people hand-edit. Every test below is really one question asked a
 * different way: after a round trip through the UI, is everything the user
 * wrote still there?
 */

import { describe, expect, it } from "vitest"
import type { ModelOptionDescriptor, SeatSpec, SeatTarget } from "../src/api"
import {
  LEGACY_TARGET_ID,
  isEmptyTarget,
  isTarget,
  optionValue,
  readTargets,
  removeTarget,
  retargetModel,
  setOption,
  targetOptions,
  targetRows,
  writeTarget,
} from "../src/settings/employees/targets"
import { isEmptySeat, isSeated, malformedModelMessage, setSkills } from "../src/settings/employees/seat"

const VARIANT: ModelOptionDescriptor = {
  id: "variant",
  label: "Reasoning effort",
  type: "select",
  choices: [
    { id: "low", label: "low" },
    { id: "high", label: "high" },
  ],
}

const THINKING: ModelOptionDescriptor = { id: "thinking", label: "Extended thinking", type: "boolean" }

describe("readTargets", () => {
  it("reads the legacy model and variant as an implicit opencode:default target", () => {
    expect(readTargets({ model: "anthropic/claude-opus-4-5", variant: "high" })).toEqual({
      [LEGACY_TARGET_ID]: {
        host: "opencode",
        model: "anthropic/claude-opus-4-5",
        options: [{ id: "variant", value: "high" }],
      },
    })
  })

  it("keeps the option id the host's own, so the value round-trips untranslated", () => {
    const target = readTargets({ model: "a/b", variant: "max" })[LEGACY_TARGET_ID]
    expect(target?.options?.[0]?.id).toBe("variant")
  })

  it("lets explicit targets win outright, so a replaced model does not come back", () => {
    const spec: SeatSpec = {
      model: "anthropic/claude-opus-4-5",
      variant: "high",
      targets: { "codex:default": { host: "codex", model: "gpt-5.6-sol" } },
    }
    expect(readTargets(spec)).toEqual({ "codex:default": { host: "codex", model: "gpt-5.6-sol" } })
  })

  it("treats an explicitly empty targets map as a statement, not as absence", () => {
    expect(readTargets({ model: "a/b", targets: {} })).toEqual({})
  })

  it("returns a fresh object, so a caller cannot mutate the config by accident", () => {
    const spec: SeatSpec = { targets: { "opencode:default": { host: "opencode" } } }
    const targets = readTargets(spec)
    delete targets["opencode:default"]
    expect(spec.targets).toHaveProperty("opencode:default")
  })

  it("answers empty for a seat that only carries skills", () => {
    expect(readTargets({ skills: [{ name: "react", description: "" }] })).toEqual({})
  })
})

describe("targetRows", () => {
  it("sorts by id, because JSON key order is whatever the user's editor left behind", () => {
    const spec: SeatSpec = {
      targets: {
        "opencode:default": { host: "opencode" },
        "claude:default": { host: "claude" },
        "codex:default": { host: "codex" },
      },
    }
    expect(targetRows(spec).map((row) => row.id)).toEqual(["claude:default", "codex:default", "opencode:default"])
  })

  it("marks a legacy-derived row so the editor can warn before it rewrites the file", () => {
    expect(targetRows({ model: "a/b" })[0]?.derived).toBe(true)
    expect(targetRows({ targets: { "opencode:default": { host: "opencode" } } })[0]?.derived).toBe(false)
  })
})

describe("writeTarget", () => {
  it("drops the legacy pair only on a save that is already writing targets", () => {
    const next = writeTarget({ model: "a/b", variant: "high" }, "codex:default", {
      host: "codex",
      model: "gpt-5.6-sol",
    })
    expect(next.model).toBeUndefined()
    expect(next.variant).toBeUndefined()
    // The legacy pair was migrated rather than discarded: it is still there,
    // in target form, beside the new one.
    expect(Object.keys(next.targets ?? {})).toEqual(["opencode:default", "codex:default"])
  })

  it("keeps skills and every field Observer does not understand", () => {
    const spec: SeatSpec = {
      model: "a/b",
      skills: [{ name: "react", description: "hooks" }],
      temperature: 0.2,
      permission: { edit: "ask" },
    }
    const next = writeTarget(spec, "claude:default", { host: "claude", model: "haiku" })
    expect(next.skills).toEqual([{ name: "react", description: "hooks" }])
    expect(next.temperature).toBe(0.2)
    expect(next.permission).toEqual({ edit: "ask" })
  })

  it("does not mutate the seat it was given", () => {
    const spec: SeatSpec = { targets: { "opencode:default": { host: "opencode" } } }
    writeTarget(spec, "codex:default", { host: "codex" })
    expect(Object.keys(spec.targets ?? {})).toEqual(["opencode:default"])
  })

  it("keeps unknown keys on the target itself", () => {
    const target = { host: "codex", model: "gpt-5.6-sol", futureKnob: 42 } as unknown as SeatTarget
    const next = writeTarget(undefined, "codex:default", target)
    expect(next.targets?.["codex:default"]).toHaveProperty("futureKnob", 42)
  })
})

describe("removeTarget", () => {
  it("leaves an explicit empty map rather than resurrecting a shadowed legacy model", () => {
    const next = removeTarget({ model: "a/b", variant: "high" }, LEGACY_TARGET_ID)
    expect(next.targets).toEqual({})
    expect(readTargets(next)).toEqual({})
    expect(next.model).toBeUndefined()
  })

  it("takes only the target it was named, and leaves the rest", () => {
    const spec: SeatSpec = {
      targets: { "opencode:default": { host: "opencode" }, "codex:default": { host: "codex" } },
    }
    expect(Object.keys(removeTarget(spec, "codex:default").targets ?? {})).toEqual(["opencode:default"])
  })
})

describe("setOption", () => {
  it("adds, then updates in place, so the option order is stable", () => {
    let target: SeatTarget = { host: "codex", model: "gpt-5.6-sol" }
    target = setOption(target, "reasoningEffort", "high")
    target = setOption(target, "serviceTier", "flex")
    target = setOption(target, "reasoningEffort", "low")
    expect(target.options).toEqual([
      { id: "reasoningEffort", value: "low" },
      { id: "serviceTier", value: "flex" },
    ])
  })

  it("stores a boolean as a boolean", () => {
    expect(optionValue(setOption({ host: "claude" }, "thinking", true), "thinking")).toBe(true)
  })

  it("deletes the options key entirely once the last one is cleared", () => {
    const target = setOption(setOption({ host: "claude" }, "thinking", true), "thinking", undefined)
    expect("options" in target).toBe(false)
  })

  it("keeps unknown keys on an option it rewrites", () => {
    const target = {
      host: "cursor",
      options: [{ id: "mode", value: "auto", note: "from a newer Observer" }],
    } as unknown as SeatTarget
    const next = setOption(target, "mode", "manual")
    expect(next.options?.[0]).toEqual({ id: "mode", value: "manual", note: "from a newer Observer" })
  })
})

describe("retargetModel: changing the model re-derives the options", () => {
  it("keeps a select value the new model still offers", () => {
    const target: SeatTarget = { host: "opencode", model: "a/b", options: [{ id: "variant", value: "high" }] }
    expect(retargetModel(target, "a/c", [VARIANT]).options).toEqual([{ id: "variant", value: "high" }])
  })

  it("clears a select value the new model does not offer", () => {
    const target: SeatTarget = { host: "opencode", model: "a/b", options: [{ id: "variant", value: "xhigh" }] }
    const next = retargetModel(target, "a/c", [VARIANT])
    expect(next.model).toBe("a/c")
    expect("options" in next).toBe(false)
  })

  it("clears an option the new model does not describe at all", () => {
    const target: SeatTarget = { host: "claude", model: "haiku", options: [{ id: "thinking", value: true }] }
    // Opus declares an effort and no thinking toggle, so the toggle goes.
    expect("options" in retargetModel(target, "opus", [VARIANT])).toBe(false)
  })

  it("keeps only the options that survive, not all or nothing", () => {
    const target: SeatTarget = {
      host: "claude",
      model: "haiku",
      options: [
        { id: "thinking", value: true },
        { id: "effort", value: "high" },
      ],
    }
    expect(retargetModel(target, "opus", [THINKING]).options).toEqual([{ id: "thinking", value: true }])
  })

  it("refuses a value of the wrong type for the descriptor it landed on", () => {
    const target = { host: "claude", model: "haiku", options: [{ id: "thinking", value: "yes" }] } as SeatTarget
    expect("options" in retargetModel(target, "haiku", [THINKING])).toBe(false)
  })

  it("keeps a value when the descriptor offers no choices to check it against", () => {
    const open: ModelOptionDescriptor = { id: "reasoningEffort", label: "Reasoning effort", type: "select" }
    const target: SeatTarget = { host: "codex", options: [{ id: "reasoningEffort", value: "whatever-codex-said" }] }
    expect(retargetModel(target, "gpt-5.6-sol", [open]).options).toEqual([
      { id: "reasoningEffort", value: "whatever-codex-said" },
    ])
  })

  it("clears the model without touching the host", () => {
    const next = retargetModel({ host: "grok", model: "grok-build" }, undefined, [])
    expect(next.host).toBe("grok")
    expect("model" in next).toBe(false)
  })
})

describe("reading a hand-edited target defensively", () => {
  it("does not mistake a number for a target", () => {
    expect(isTarget(7)).toBe(false)
    expect(isTarget([])).toBe(false)
    expect(isTarget({ host: "opencode" })).toBe(true)
  })

  it("filters malformed options out of what a host could act on, and leaves them in the config", () => {
    const target = {
      host: "opencode",
      options: [{ id: "variant", value: { deep: true } }, { id: "", value: "x" }, { id: "ok", value: "yes" }],
    } as unknown as SeatTarget
    expect(targetOptions(target).map((option) => option.id)).toEqual(["ok"])
    expect(target.options).toHaveLength(3)
  })

  it("counts a malformed option when deciding a target is not empty, so it is still editable", () => {
    const target = { host: "opencode", options: [{ nonsense: true }] } as unknown as SeatTarget
    expect(isEmptyTarget(target)).toBe(false)
    expect(isEmptyTarget({ host: "opencode" })).toBe(true)
  })
})

describe("the seat around the targets", () => {
  it("counts an employee with only skills as seated", () => {
    expect(isSeated({ skills: [{ name: "react", description: "" }] })).toBe(true)
    expect(isSeated({ targets: {} })).toBe(false)
    expect(isSeated(undefined)).toBe(false)
  })

  it("refuses to call a seat empty while it carries a field Observer does not apply", () => {
    expect(isEmptySeat({ targets: {} })).toBe(true)
    expect(isEmptySeat({ targets: {}, temperature: 0.2 })).toBe(false)
  })

  it("deletes the skills key rather than storing an empty array the daemon would drop", () => {
    expect("skills" in setSkills({ skills: [{ name: "react", description: "" }] }, [])).toBe(false)
  })
})

describe("malformedModelMessage", () => {
  it("applies the slash rule to OpenCode, whose addressing scheme it is", () => {
    expect(malformedModelMessage("opencode", "claude-opus-4-5")).toMatch(/missing its provider/)
    expect(malformedModelMessage("opencode", "anthropic/claude-opus-4-5")).toBeUndefined()
  })

  it("never applies it to another host, where a bare slug is exactly right", () => {
    expect(malformedModelMessage("codex", "gpt-5.6-sol")).toBeUndefined()
    expect(malformedModelMessage("grok", "grok-build")).toBeUndefined()
    expect(malformedModelMessage("claude", "haiku")).toBeUndefined()
    expect(malformedModelMessage("cursor", "composer-2")).toBeUndefined()
  })
})

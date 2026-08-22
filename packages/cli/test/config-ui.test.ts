import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { diagnoseSeats } from "../../../apps/daemon/dist/index.js"
import {
  type ConfigUIState,
  type EmployeeRow,
  type Key,
  type ModelInfo,
  type SeatsConfig,
  applied,
  buildCatalogue,
  effortCycle,
  initialState,
  pickerEntries,
  reduce,
  render,
  renderReport,
  rosterRows,
} from "../dist/index.js"

/**
 * The reducer and the renderer are pure, so every test here is a list of
 * keystrokes and an assertion on the resulting state or on lines of text. No
 * terminal, no config file, no subprocess — the same shape as
 * `install.test.ts` asserting on JSON.
 */

const ROSTER: EmployeeRow[] = [
  { id: "arjun-mehta", name: "Arjun Mehta", role: "Senior Frontend Engineer" },
  { id: "malik-johnson", name: "Malik Johnson", role: "Staff Backend Engineer" },
  { id: "elias-mercer", name: "Elias Mercer", role: "Senior DevOps Engineer" },
]

const MODELS: ModelInfo[] = buildCatalogue({
  catalogue: JSON.stringify({
    anthropic: {
      name: "Anthropic",
      models: {
        "claude-opus-4-8": {
          name: "Claude Opus 4.8",
          release_date: "2026-02-01",
          limit: { context: 1_000_000 },
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        },
        "claude-haiku-4": {
          name: "Claude Haiku 4",
          release_date: "2025-06-01",
          limit: { context: 200_000 },
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        },
        // Mechanisms but no effort scale. The host synthesises a variant map
        // for these from the model family and the provider's SDK, so the
        // catalogue cannot rule and the picker must not pretend it can.
        "claude-sonnet-4-5": {
          name: "Claude Sonnet 4.5",
          release_date: "2025-09-29",
          limit: { context: 200_000 },
          reasoning_options: [{ type: "budget_tokens", min: 1024 }],
        },
      },
    },
    openai: {
      name: "OpenAI",
      models: {
        "gpt-5-nano": {
          name: "GPT-5 Nano",
          release_date: "2025-08-01",
          limit: { context: 400_000 },
          reasoning_options: [],
        },
        // No reasoning mechanisms at all: a real "takes no effort", measured
        // as such on every one of the 3 506 models in this shape.
        "gpt-4o": {
          name: "GPT-4o",
          release_date: "2024-05-01",
          limit: { context: 128_000 },
        },
      },
    },
  }),
})

/** Picker rows: 0 inherit, 1 Opus, 2 Sonnet, 3 Haiku, 4 Nano, 5 GPT-4o. */
const OPUS = 1
const SONNET = 2
const HAIKU = 3
const NANO = 4
const GPT4O = 5

function start(seats: Partial<SeatsConfig> = {}): ConfigUIState {
  return initialState({
    seats: { control: false, employees: {}, ...seats },
    roster: ROSTER,
    models: MODELS,
  })
}

/** `"down"` is a key name; `"a"` is a character typed into a text field. */
function press(state: ConfigUIState, ...keys: Array<string | Key>): ConfigUIState {
  return keys.reduce<ConfigUIState>((current, key) => reduce(current, asKey(key)), state)
}

function type(state: ConfigUIState, text: string): ConfigUIState {
  return [...text].reduce<ConfigUIState>((current, char) => reduce(current, { name: char, sequence: char }), state)
}

function asKey(key: string | Key): Key {
  if (typeof key !== "string") return key
  return key.length === 1 ? { name: key, sequence: key } : { name: key }
}

describe("navigation", () => {
  it("walks the employee list and wraps at both ends", () => {
    expect(press(start(), "down").cursor.employees).toBe(1)
    expect(press(start(), "down", "down", "down").cursor.employees).toBe(0)
    expect(press(start(), "up").cursor.employees).toBe(ROSTER.length - 1)
  })

  it("accepts j and k as well as the arrows", () => {
    expect(press(start(), "j", "j").cursor.employees).toBe(2)
    expect(press(start(), "j", "k").cursor.employees).toBe(0)
  })

  it("drills from the list into an employee and on into the model picker", () => {
    const state = press(start(), "down", "return")
    expect(state.view).toBe("employee")
    expect(state.employeeId).toBe("malik-johnson")

    const picker = press(state, "return")
    expect(picker.view).toBe("models")
  })

  it("unwinds one view at a time with esc", () => {
    const picker = press(start(), "return", "return")
    expect(picker.view).toBe("models")
    const employee = press(picker, "escape")
    expect(employee.view).toBe("employee")
    const list = press(employee, "escape")
    expect(list.view).toBe("employees")
    expect(press(list, "escape").request).toBe("quit")
  })

  it("always opens an employee on the Model row", () => {
    // Model is what a user came for nine times out of ten, so the row cursor
    // resets rather than remembering where they last were.
    const state = press(start(), "return", "down")
    expect(state.cursor.employee).toBe(1)
    expect(press(state, "escape", "return").cursor.employee).toBe(0)
  })

  it("jumps between vendor groups with tab and shift+tab", () => {
    const picker = press(start(), "return", "return")
    const first = press(picker, "tab")
    expect(pickerEntries(first)[first.cursor.models]?.providerLabel).toBe("Anthropic")
    const second = press(first, "tab")
    expect(pickerEntries(second)[second.cursor.models]?.providerLabel).toBe("OpenAI")
    const back = press(second, { name: "tab", shift: true })
    expect(pickerEntries(back)[back.cursor.models]?.providerLabel).toBe("Anthropic")
  })
})

describe("effort", () => {
  it("cycles through exactly what the highlighted model declares, and wraps", () => {
    // Haiku stops at high. Its cycle is off, low, medium, high.
    const at = (state: ConfigUIState): string | undefined => state.draftVariant
    let state = press(start(), "return", "return", ...Array<string>(HAIKU).fill("down"))
    expect(effortCycle(state).values).toEqual([undefined, "low", "medium", "high"])

    state = press(state, "right")
    expect(at(state)).toBe("low")
    state = press(state, "right", "right")
    expect(at(state)).toBe("high")
    state = press(state, "right")
    expect(at(state)).toBeUndefined()
    state = press(state, "left")
    expect(at(state)).toBe("high")
  })

  it("offers no effort on the inherit row, because a variant with no model does nothing", () => {
    const picker = press(start(), "return", "return")
    expect(pickerEntries(picker)[picker.cursor.models]?.kind).toBe("inherit")
    expect(effortCycle(picker).values).toEqual([undefined])

    const nudged = press(picker, "right")
    expect(nudged.draftVariant).toBeUndefined()
    expect(nudged.status).toContain("Reasoning effort needs a model")
  })

  it("says the model takes no reasoning effort when it genuinely takes none", () => {
    // State 2. Nano declares an empty mechanism list, which the host resolves
    // to an empty variant map every time. There is no control to draw, and
    // saying so is more use to the user than a blank column.
    const state = press(start(), "return", "return", ...Array<string>(NANO).fill("down"), "right")
    expect(state.draftVariant).toBeUndefined()
    expect(state.status).toBe("GPT-5 Nano takes no reasoning effort, so there is nothing to cycle through.")
  })

  it("says the same for a model with no reasoning mechanisms at all", () => {
    const state = press(start(), "return", "return", ...Array<string>(GPT4O).fill("down"), "right")
    expect(effortCycle(state).values).toEqual([undefined])
    expect(effortCycle(state).known).toBe(true)
    expect(state.status).toBe("GPT-4o takes no reasoning effort, so there is nothing to cycle through.")
  })

  it("OFFERS THE SUGGESTION LIST FOR A MODEL WHOSE EFFORTS IT CANNOT WORK OUT", () => {
    /**
     * State 3, and the defect that prompted all of this.
     *
     * Sonnet 4.5 declares `budget_tokens` and no effort scale. Observer used
     * to read that as "no efforts" and draw an empty control for 958 models.
     * The host synthesises a variant map for `budget_tokens` — `high` and
     * `max` for this very model on anthropic — so the honest answer is the
     * suggestion list, flagged as a guess.
     */
    const state = press(start(), "return", "return", ...Array<string>(SONNET).fill("down"))
    const cycle = effortCycle(state)
    expect(cycle.known).toBe(false)
    expect(cycle.values).toEqual([undefined, "none", "minimal", "low", "medium", "high", "xhigh", "max"])

    const nudged = press(state, "right")
    expect(nudged.draftVariant).toBe("none")
    expect(nudged.status).toContain("the host has the final say")
  })

  it("keeps 'takes no effort' and 'cannot tell' apart in the rendered picker", () => {
    // The two states that used to render identically. Neither is a blank cell.
    const wide = { rows: 30, columns: 100 }
    const onSonnet = press(start(), "return", "return", ...Array<string>(SONNET).fill("down"))
    const text = render(onSonnet, wide).join("\n")
    // The picker names models by id, the provider being a group header already.
    expect(text).toContain("claude-sonnet-4-5")
    // Unselected rows: a verdict for one, an admission for the other.
    expect(text).toContain("takes no effort")
    // Selected row: the guessed scale, with `off` armed and bracketed.
    expect(text).toContain("[off] none minimal low medium high xhigh max")

    const onNano = press(onSonnet, ...Array<string>(NANO - SONNET).fill("down"))
    expect(render(onNano, wide).join("\n")).toContain("this model takes no reasoning effort")
  })


  it("drops an effort the model under the cursor does not offer", () => {
    // max on Opus, then move to Haiku, which stops at high.
    let state = press(start(), "return", "return", "down")
    state = press(state, "left")
    expect(state.draftVariant).toBe("max")
    state = press(state, ...Array<string>(HAIKU - OPUS).fill("down"))
    expect(pickerEntries(state)[state.cursor.models]?.model?.id).toBe("anthropic/claude-haiku-4")
    expect(state.draftVariant).toBeUndefined()
    expect(state.status).toContain('does not offer "max" effort')
  })

  it("keeps the armed effort when it moves onto a model whose scale it cannot work out", () => {
    /**
     * The other half of the clamp, and the reason it tests `known` and not
     * just membership.
     *
     * Opus offers max; Sonnet 4.5 declares only `budget_tokens`, so Observer
     * has no list to clamp against. Clearing here would be a verdict we have
     * no grounds for — and on the live host this model does accept `max`. The
     * suggestion scale the picker draws for it includes max, so keeping it
     * armed is also the only answer consistent with what is on screen.
     */
    let state = press(start(), "return", "return", ...Array<string>(OPUS).fill("down"), "left")
    expect(state.draftVariant).toBe("max")
    state = press(state, ...Array<string>(SONNET - OPUS).fill("down"))
    expect(pickerEntries(state)[state.cursor.models]?.model?.id).toBe("anthropic/claude-sonnet-4-5")
    expect(state.draftVariant).toBe("max")
    expect(state.status).not.toContain("does not offer")
  })

  it("clears the armed effort on a model that takes none at all", () => {
    // Nano resolves to an empty variant map, and that is a list to clamp
    // against: every variant is unsupported, so nothing may stay armed. `tab`
    // jumps straight from the Anthropic group to it, so the clearing is Nano's
    // doing and not some model passed on the way.
    let state = press(start(), "return", "return", ...Array<string>(OPUS).fill("down"), "left")
    expect(state.draftVariant).toBe("max")
    state = press(state, "tab")
    expect(pickerEntries(state)[state.cursor.models]?.model?.id).toBe("openai/gpt-5-nano")
    expect(state.draftVariant).toBeUndefined()
    expect(state.status).toContain('does not offer "max" effort')
  })

  it("clears the armed effort on the way back to the inherit row", () => {
    const state = press(start(), "return", "return", ...Array<string>(OPUS).fill("down"), "left", "up")
    expect(pickerEntries(state)[state.cursor.models]?.kind).toBe("inherit")
    expect(state.draftVariant).toBeUndefined()
  })

  it("treats the suggestion list as a guess for a model it does not know", () => {
    let state = press(start(), "return", "return", "m")
    state = type(state, "someone/exotic-model")
    state = press(state, "return")
    expect(state.seats.employees["arjun-mehta"]?.model).toBe("someone/exotic-model")

    // Re-opening the picker on an unknown model still offers a scale, flagged.
    const reopened = press(state, "return")
    expect(effortCycle(reopened).known).toBe(false)
    expect(press(reopened, "right").status).toContain("suggestions")
  })
})

describe("assigning a model", () => {
  it("writes the model onto the seat and returns to the employee view", () => {
    const state = press(start(), "return", "return", ...Array<string>(OPUS).fill("down"), "return")
    expect(state.view).toBe("employee")
    expect(state.seats.employees["arjun-mehta"]).toEqual({ model: "anthropic/claude-opus-4-8" })
    expect(state.dirty).toBe(true)
  })

  it("commits the model and the effort together", () => {
    const state = press(start(), "return", "return", ...Array<string>(OPUS).fill("down"), "right", "return")
    expect(state.seats.employees["arjun-mehta"]).toEqual({
      model: "anthropic/claude-opus-4-8",
      variant: "low",
    })
  })

  it("drops the effort when the model goes back to inherit", () => {
    const assigned = press(start(), "return", "return", ...Array<string>(OPUS).fill("down"), "right", "return")
    const cleared = press(assigned, "return", "up", "return")
    expect(cleared.seats.employees["arjun-mehta"]).toBeUndefined()
    expect(cleared.status).toContain("the effort was dropped with it")
  })

  it("cannot produce a variant with no model, however you drive it", () => {
    // The property the whole picker is shaped around: model and variant are
    // written by one action, so this UI can never author the config
    // `diagnoseSeats` warns about.
    const states = [
      press(start(), "return", "return", "right", "return"),
      press(start(), "return", "return", "down", "right", "return", "return", "up", "return"),
      press(start(), "return", "return", "down", "left", "return"),
    ]
    for (const state of states) {
      const seat = state.seats.employees["arjun-mehta"]
      if (seat?.variant !== undefined) expect(typeof seat.model).toBe("string")
      expect(diagnoseSeats(state.seats).issues.some((issue) => issue.code === "variant-without-model")).toBe(false)
    }
  })

  it("opens the picker on the model the seat already names", () => {
    const seats: SeatsConfig = {
      control: true,
      employees: { "arjun-mehta": { model: "anthropic/claude-haiku-4", variant: "medium" } },
    }
    const picker = press(initialState({ seats, roster: ROSTER, models: MODELS }), "return", "return")
    expect(picker.cursor.models).toBe(HAIKU)
    expect(picker.draftVariant).toBe("medium")
  })

  it("shows a configured model the catalogue cannot describe, rather than hiding it behind inherit", () => {
    // Otherwise the cursor would sit on "inherit" while the seat plainly names
    // a model, which reads as "your model is gone".
    const seats: SeatsConfig = { control: true, employees: { "arjun-mehta": { model: "bedrock/anthropic.claude-v9" } } }
    const picker = press(initialState({ seats, roster: ROSTER, models: MODELS }), "return", "return")
    const entry = pickerEntries(picker)[picker.cursor.models]
    expect(picker.cursor.models).toBe(1)
    expect(entry?.model?.id).toBe("bedrock/anthropic.claude-v9")
    expect(entry?.model?.known).toBe(false)
    expect(render(picker, { rows: 40, columns: 100 }).join("\n")).toContain("bedrock (not in the catalogue)")
  })

  it("takes a hand-typed provider/model when the catalogue cannot help", () => {
    const empty = initialState({ seats: { control: false, employees: {} }, roster: ROSTER, models: [] })
    let state = press(empty, "return", "return", "m")
    state = type(state, "bedrock/some-model")
    state = press(state, "return")
    expect(state.seats.employees["arjun-mehta"]?.model).toBe("bedrock/some-model")
  })

  it("stores a malformed model rather than swallowing it, and lets diagnoseSeats say why", () => {
    let state = press(start(), "return", "return", "m")
    state = type(state, "claude-opus")
    state = press(state, "return")
    const issue = diagnoseSeats(state.seats).issues.find((entry) => entry.code === "malformed-model")
    expect(issue?.severity).toBe("error")
    expect(collapse(render(state, { rows: 40, columns: 100 }).join("\n"))).toContain(collapse(issue!.message))
  })

  it("discards a half-typed model on esc", () => {
    let state = press(start(), "return", "return", "m")
    state = type(state, "half")
    state = press(state, "escape")
    expect(state.entry).toBeUndefined()
    expect(state.seats.employees["arjun-mehta"]).toBeUndefined()
  })

  it("backspaces inside a text field", () => {
    let state = press(start(), "return", "return", "m")
    state = type(state, "abc")
    state = press(state, "backspace")
    expect(state.entry?.value).toBe("ab")
  })
})

describe("filtering", () => {
  it("narrows the picker and resets the cursor to the top", () => {
    let state = press(start(), "return", "return", "down", "down", "/")
    state = type(state, "haiku")
    state = press(state, "return")
    expect(state.filter).toBe("haiku")
    expect(state.cursor.models).toBe(0)
    expect(pickerEntries(state)).toHaveLength(2)
  })

  it("says nothing matched rather than showing an empty box", () => {
    let state = press(start(), "return", "return", "/")
    state = type(state, "zzz")
    state = press(state, "return")
    expect(render(state, { rows: 40, columns: 100 }).join("\n")).toContain('Nothing matches "zzz"')
  })
})

describe("skills", () => {
  it("adds comma-separated skills to the seat", () => {
    let state = press(start(), "return", "down", "return")
    state = type(state, "react, accessibility")
    state = press(state, "return")
    expect(state.seats.employees["arjun-mehta"]?.skills).toEqual([
      { name: "react", description: "" },
      { name: "accessibility", description: "" },
    ])
  })

  it("says out loud that skills do not depend on seat control", () => {
    let state = press(start(), "return", "down", "return")
    state = type(state, "react")
    state = press(state, "return")
    expect(state.status).toContain("whether or not seat control is on")
  })

  it("clears skills when the field is emptied", () => {
    const seats: SeatsConfig = { control: false, employees: { "arjun-mehta": { skills: [{ name: "react", description: "" }] } } }
    let state = press(initialState({ seats, roster: ROSTER, models: MODELS }), "return", "down", "return")
    expect(state.entry?.value).toBe("react")
    state = press(state, "backspace", "backspace", "backspace", "backspace", "backspace", "return")
    expect(state.seats.employees["arjun-mehta"]).toBeUndefined()
  })
})

describe("reset", () => {
  it("clears model, effort and skills for one employee", () => {
    const seats: SeatsConfig = {
      control: true,
      employees: {
        "arjun-mehta": { model: "anthropic/claude-opus-4-8", variant: "high" },
        "malik-johnson": { model: "openai/gpt-5-nano" },
      },
    }
    const state = press(initialState({ seats, roster: ROSTER, models: MODELS }), "return", "down", "down", "return")
    expect(state.seats.employees["arjun-mehta"]).toBeUndefined()
    expect(state.seats.employees["malik-johnson"]).toBeDefined()
    expect(state.dirty).toBe(true)
  })

  it("keeps hand-written fields Observer does not apply", () => {
    // The index signature on SeatSpec exists so a user's `temperature`
    // survives. Clearing the model must not take it with it.
    const seats: SeatsConfig = {
      control: true,
      employees: { "arjun-mehta": { model: "anthropic/claude-opus-4-8", temperature: 0.2 } },
    }
    const state = press(initialState({ seats, roster: ROSTER, models: MODELS }), "return", "return", "up", "return")
    expect(state.seats.employees["arjun-mehta"]).toEqual({ temperature: 0.2 })
  })

  it("does nothing, loudly, when there is no seat to reset", () => {
    const state = press(start(), "return", "down", "down", "return")
    expect(state.status).toBe("This employee has no seat to reset.")
    expect(state.dirty).toBe(false)
  })
})

describe("seat control", () => {
  it("toggles from the employee list and explains what changed", () => {
    const on = press(start(), "c")
    expect(on.seats.control).toBe(true)
    expect(on.status).toContain("models and efforts will be applied")
    const off = press(on, "c")
    expect(off.seats.control).toBe(false)
    expect(off.status).toContain("Skills still apply")
  })

  it("marks the config dirty", () => {
    expect(press(start(), "c").dirty).toBe(true)
  })
})

describe("saving and quitting", () => {
  it("asks for a save only when there is something to save", () => {
    expect(press(start(), "s").request).toBeUndefined()
    expect(press(start(), "s").status).toBe("Nothing to save.")
    expect(press(start(), "c", "s").request).toBe("save")
  })

  it("quits straight away when nothing is unsaved", () => {
    expect(press(start(), "escape").request).toBe("quit")
    expect(press(start(), "q").request).toBe("quit")
  })

  it("asks before discarding unsaved edits", () => {
    const dirty = press(start(), "c")
    const asking = press(dirty, "escape")
    expect(asking.confirmQuit).toBe(true)
    expect(asking.request).toBeUndefined()
    expect(press(asking, "escape").confirmQuit).toBe(false)
    expect(press(asking, "q").request).toBe("quit")
  })

  it("saves and then quits when asked on the way out", () => {
    const asking = press(press(start(), "c"), "escape")
    const saving = press(asking, "s")
    expect(saving.request).toBe("save")
    expect(saving.quitAfterSave).toBe(true)
    const done = applied(saving, { saved: true, status: "Saved." })
    expect(done.request).toBe("quit")
    expect(done.dirty).toBe(false)
  })

  it("cancels the quit and keeps the edits when the save fails", () => {
    const saving = press(press(press(start(), "c"), "escape"), "s")
    const failed = applied(saving, { saved: false, status: "Could not save: disk full" })
    expect(failed.request).toBeUndefined()
    expect(failed.confirmQuit).toBe(true)
    expect(failed.dirty).toBe(true)
    expect(failed.status).toContain("disk full")
  })

  it("lets ctrl+c out of any mode, including a half-typed field", () => {
    let state = press(start(), "return", "return", "m")
    state = type(state, "half-typed")
    expect(reduce(state, { name: "c", ctrl: true, sequence: "\u0003" }).request).toBe("quit")
  })

  it("does not treat ctrl+a as text", () => {
    const state = press(start(), "return", "return", "m")
    expect(reduce(state, { name: "a", ctrl: true, sequence: "\u0001" }).entry?.value).toBe("")
  })

  it("returns the same state object for a key that does nothing", () => {
    const state = start()
    expect(reduce(state, { name: "z", sequence: "z" })).toBe(state)
  })
})

describe("render", () => {
  const viewport = { rows: 30, columns: 100 }

  const seated = initialState({
    seats: {
      control: false,
      employees: { "arjun-mehta": { model: "anthropic/claude-opus-4-8", variant: "high", skills: [{ name: "react", description: "" }] } },
    },
    roster: ROSTER,
    models: MODELS,
  })

  it("emits no ANSI colour at all, so NO_COLOR needs no branch", () => {
    for (const state of [seated, press(seated, "return"), press(seated, "return", "return")]) {
      expect(render(state, viewport).join("\n")).not.toMatch(/\u001B\[/)
    }
  })

  it("draws the employee list with every column, aligned", () => {
    const lines = render(seated, viewport)
    const header = lines.find((line) => line.includes("Employee") && line.includes("Effort"))
    expect(header).toBeDefined()
    const row = lines.find((line) => line.includes("Arjun Mehta"))!
    expect(row.startsWith("> Arjun Mehta")).toBe(true)
    expect(row).toContain("Senior Frontend Engineer")
    expect(row).toContain("anthropic/claude-opus-4-8")
    expect(row).toContain("high")
    expect(row).toContain("react")
    // Columns line up because every cell is padded to a fixed width.
    expect(row.indexOf("anthropic")).toBe(lines.find((line) => line.includes("Model"))!.indexOf("Model"))
  })

  it("says on every screen whether seat control is on and whether anything is in effect", () => {
    const off = render(seated, viewport).join("\n")
    expect(off).toContain("Seat control        off - model and effort are inert; skills still apply")
    // The seated fixture has skills, and skills are not gated on control, so
    // this config does change something even with control off.
    expect(off).toContain("Right now           this config changes what runs")

    const modelOnly = initialState({
      seats: { control: false, employees: { "arjun-mehta": { model: "anthropic/claude-opus-4-8" } } },
      roster: ROSTER,
      models: MODELS,
    })
    expect(render(modelOnly, viewport).join("\n")).toContain("Right now           this config changes nothing")

    const on = render({ ...seated, seats: { ...seated.seats, control: true } }, viewport).join("\n")
    expect(on).toContain("Seat control        on - Observer sets the model and effort")
    expect(on).toContain("Right now           this config changes what runs")
  })

  it("names the one host that can honour any of this", () => {
    expect(render(seated, viewport).join("\n")).toContain(
      "Applies to          OpenCode only - Codex, Claude Code and Copilot CLI are not seated",
    )
  })

  it("says seat control reaches `general` delegations only, in observer doctor's words", () => {
    /**
     * The second narrowing, and it is not cosmetic.
     *
     * Seating works by rewriting `subagent_type`, and doing that to a
     * specialised agent would throw away its own prompt, tools and
     * deny-by-default permissions — so only `general` delegations are ever
     * reseated. A header that named the host but not the agent type would
     * leave a user believing every subagent they see moves onto the model
     * they just picked. `observer doctor` already says this sentence; the
     * wording is copied rather than reworded so the two cannot drift.
     */
    // Wrapped into the gutter at narrow widths, so compare on collapsed
    // whitespace rather than pinning a line break.
    const text = collapse(render(seated, viewport).join("\n"))
    expect(text).toContain(
      collapse("`general` delegations only - any other agent keeps its own prompt, tools and model"),
    )
  })

  it("wraps a header value into the gutter rather than clipping the end off it", () => {
    // The sentences in this block exist to be read in full; "...keeps its own
    // prompt, tools and mo..." is worse than two lines.
    for (const columns of [60, 80, 100, 160]) {
      const text = collapse(render(seated, { rows: 30, columns }).join("\n"))
      expect(text).toContain(collapse("any other agent keeps its own prompt, tools and model"))
    }
  })

  it("renders diagnoseSeats sentences verbatim rather than rewording them", () => {
    const broken = initialState({
      seats: { control: false, employees: { "malik-johnson": { variant: "high" } } },
      roster: ROSTER,
      models: MODELS,
    })
    const issue = diagnoseSeats(broken.seats).issues.find((entry) => entry.code === "variant-without-model")!
    const text = render(broken, viewport).join("\n")
    // Wrapped across lines, so compare on collapsed whitespace.
    expect(collapse(text)).toContain(collapse(issue.message))
    expect(text).toContain("warning:")
  })

  it("flags the row of a seat with a finding, in the gutter", () => {
    const broken = initialState({
      seats: { control: false, employees: { "malik-johnson": { variant: "high" } } },
      roster: ROSTER,
      models: MODELS,
    })
    const row = render(broken, viewport).find((line) => line.includes("Malik Johnson"))!
    expect(row.startsWith(" !")).toBe(true)
  })

  it("shows the effort scale on the highlighted picker row with the armed level bracketed", () => {
    const picker = press(seated, "return", "return")
    const lines = render(picker, viewport)
    expect(lines.some((line) => line.includes("Context") && line.includes("Reasoning"))).toBe(true)
    const row = lines.find((line) => line.startsWith("> ") && line.includes("claude-opus-4-8"))!
    expect(row).toContain("1M")
    expect(row).toContain("[high]")
    expect(row).toContain("low medium")
    // Unhighlighted rows compress to a range instead of the full scale.
    expect(lines.find((line) => line.includes("claude-haiku-4"))).toContain("low-high")
  })

  it("groups the picker by vendor", () => {
    const lines = render(press(seated, "return", "return"), viewport)
    expect(lines).toContain("  Anthropic")
    expect(lines).toContain("  OpenAI")
  })

  it("explains an empty catalogue instead of dead-ending", () => {
    const empty = initialState({ seats: { control: false, employees: {} }, roster: ROSTER, models: [] })
    const lines = render(press(empty, "return", "return"), viewport)
    expect(lines.join("\n")).toContain("No models to list.")
    expect(lines.join("\n")).toContain("m type a model")
  })

  it("keeps the key hints when the terminal is too short for the list", () => {
    const lines = render(seated, { rows: 12, columns: 100 })
    expect(lines[lines.length - 1]).toContain("esc quit")
    expect(lines.length).toBeLessThanOrEqual(24)
  })

  it("keeps every column readable at 80 columns", () => {
    const lines = render(seated, { rows: 30, columns: 80 })
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(80)
    expect(lines.find((line) => line.includes("Arjun Mehta"))).toContain("high")
  })

  it("changes the hints with the view", () => {
    expect(render(seated, viewport).at(-1)).toContain("c toggle seat control")
    expect(render(press(seated, "return"), viewport).at(-1)).toContain("enter change")
    expect(render(press(seated, "return", "return"), viewport).at(-1)).toContain("left/right effort")
    expect(render(press(press(seated, "c"), "escape"), viewport).at(-1)).toContain("s save and quit")
  })
})

describe("renderReport", () => {
  it("prints the seats as plain text", () => {
    const seats: SeatsConfig = {
      control: true,
      employees: { "arjun-mehta": { model: "anthropic/claude-opus-4-8", variant: "high" } },
    }
    const text = renderReport(seats, ROSTER).join("\n")
    expect(text).toContain("control             on")
    expect(text).toContain("in effect           yes")
    expect(text).toContain("arjun-mehta")
    expect(text).toContain("anthropic/claude-opus-4-8")
    expect(text).toContain("Run `observer config` in a terminal")
    expect(text).not.toMatch(/\u001B\[/)
  })

  it("says plainly when no employee is seated", () => {
    const text = renderReport({ control: false, employees: {} }, ROSTER).join("\n")
    expect(text).toContain("No employee has a seat.")
  })

  it("surfaces a seat whose id is not on the roster", () => {
    const text = renderReport({ control: false, employees: { nobody: { model: "a/b" } } }, ROSTER).join("\n")
    expect(text).toContain("nobody")
    expect(text).toContain("not on the roster")
  })
})

describe("rosterRows", () => {
  it("projects the whole roster, ids intact", () => {
    const rows = rosterRows()
    expect(rows).toHaveLength(14)
    expect(rows[0]).toEqual({ id: "arjun-mehta", name: "Arjun Mehta", role: "Senior Frontend Engineer" })
    // Every id must be one diagnoseSeats recognises, or the UI would flag its
    // own rows as unknown employees.
    const seats: SeatsConfig = { control: false, employees: Object.fromEntries(rows.map((row) => [row.id, { model: "a/b" }])) }
    expect(diagnoseSeats(seats).issues.some((issue) => issue.code === "unknown-employee")).toBe(false)
  })
})

describe("observer config without a terminal", () => {
  it("prints the seats and exits 0 instead of hanging on raw mode", () => {
    const home = mkdtempSync(join(tmpdir(), "observer-config-"))
    try {
      const output = execFileSync(process.execPath, [join(process.cwd(), "packages/cli/dist/cli.js"), "config"], {
        encoding: "utf8",
        env: { ...process.env, OBSERVER_HOME: home, HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 20_000,
      })
      expect(output).toContain("Observer seats")
      expect(output).toContain("No employee has a seat.")
      expect(output).not.toMatch(/\u001B\[/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

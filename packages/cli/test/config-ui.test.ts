import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type ModelCatalogue, diagnoseSeats } from "../../../apps/daemon/dist/index.js"
import {
  type ConfigUIState,
  type EmployeeRow,
  type Key,
  type ModelInfo,
  type SeatsConfig,
  type TargetProfile,
  applied,
  buildCatalogue,
  buildTheme,
  colorSupport,
  catalogueApplied,
  diagnoseOpencodeSeats,
  effortCycle,
  initialState,
  menuRows,
  pickerEntries,
  reduce,
  render,
  renderReport,
  rosterRows,
  targetRows,
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

const TARGET_PROFILES: TargetProfile[] = [
  {
    id: "opencode:default",
    host: "opencode",
    hostLabel: "OpenCode",
    profileLabel: "default",
    capabilities: {
      discovery: "cached",
      childModel: "supported",
      childReasoning: "supported",
      requiresReload: true,
    },
  },
  {
    id: "codex:default",
    host: "codex",
    hostLabel: "Codex",
    profileLabel: "default",
    capabilities: {
      discovery: "live",
      childModel: "experimental",
      childReasoning: "experimental",
      requiresReload: true,
    },
  },
  {
    id: "copilot:default",
    host: "copilot",
    hostLabel: "GitHub Copilot CLI",
    profileLabel: "default",
    capabilities: {
      discovery: "live",
      childModel: "unsupported",
      childReasoning: "unsupported",
      requiresReload: true,
    },
  },
]

const TARGET_CATALOGUES: Record<string, ModelCatalogue> = {
  "opencode:default": {
    source: "fixture",
    freshness: "cached",
    warnings: [],
    models: [
      {
        id: "github-copilot/claude-opus-5",
        label: "Claude Opus 5",
        options: [
          {
            id: "variant",
            label: "Reasoning effort",
            type: "select",
            choices: [
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
            ],
          },
        ],
      },
    ],
  },
  "codex:default": {
    source: "fixture",
    freshness: "live",
    warnings: [],
    models: [
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        options: [
          {
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select",
            choices: [
              { id: "low", label: "low" },
              { id: "high", label: "high" },
            ],
          },
        ],
      },
    ],
  },
  "copilot:default": {
    source: "fixture",
    freshness: "live",
    warnings: [],
    models: [
      {
        id: "claude-opus-5",
        label: "Claude Opus 5",
        options: [
          {
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select",
            choices: [
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
            ],
          },
        ],
      },
      {
        id: "claude-haiku-4.5",
        label: "Claude Haiku 4.5",
        options: [
          {
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select",
            choices: [{ id: "low", label: "low" }],
          },
        ],
      },
    ],
  },
}

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

function targetStart(
  seats: Partial<SeatsConfig> = {},
  catalogues: Record<string, ModelCatalogue> = TARGET_CATALOGUES,
): ConfigUIState {
  return initialState({
    seats: { control: true, employees: {}, ...seats },
    roster: ROSTER,
    models: [],
    profiles: TARGET_PROFILES,
    catalogues,
  })
}

/**
 * The employee list, which is one level in from the menu.
 *
 * The UI opens on the menu, so anything about the roster, a seat or the model
 * picker starts by walking to `Employees` and pressing enter. Tests say that
 * once, here, rather than carrying two extra keystrokes each.
 */
function into(state: ConfigUIState): ConfigUIState {
  return press(state, "down", "return")
}

function employees(seats: Partial<SeatsConfig> = {}): ConfigUIState {
  return into(start(seats))
}

function targets(
  seats: Partial<SeatsConfig> = {},
  catalogues: Record<string, ModelCatalogue> = TARGET_CATALOGUES,
): ConfigUIState {
  return press(into(targetStart(seats, catalogues)), "return", "return")
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

describe("the main menu", () => {
  /**
   * The top level exists so that nothing a user needs is behind a key they
   * have to be told about. Seat control used to be exactly that: a `c` in the
   * hint bar and nothing on screen to press.
   */
  it("opens on the menu, with seat control as its first row", () => {
    const state = start()
    expect(state.view).toBe("menu")
    expect(menuRows(state)[state.cursor.menu]).toBe("control")
  })

  it("turns seat control on and off from the row itself, with enter or space", () => {
    const on = press(start(), "return")
    expect(on.seats.control).toBe(true)
    expect(on.status).toContain("models and efforts will be applied")
    expect(press(on, { name: "space" }).seats.control).toBe(false)
  })

  it("walks to the employee list and back", () => {
    const list = into(start())
    expect(list.view).toBe("employees")
    expect(press(list, "escape").view).toBe("menu")
  })

  it("offers Save & exit only when there is something to save", () => {
    expect(menuRows(start())).toEqual(["control", "employees", "exit"])
    expect(menuRows(press(start(), "c"))).toEqual(["control", "employees", "save", "exit"])
  })

  it("saves and then leaves from the Save & exit row, because that is what it says", () => {
    const onSave = press(start(), "c", "down", "down")
    expect(menuRows(onSave)[onSave.cursor.menu]).toBe("save")
    const saving = press(onSave, "return")
    expect(saving.request).toBe("save")
    expect(saving.quitAfterSave).toBe(true)
    expect(applied(saving, { saved: true, status: "Saved." }).request).toBe("quit")
  })

  it("keeps the user on screen when that save fails", () => {
    const saving = press(press(start(), "c", "down", "down"), "return")
    const failed = applied(saving, { saved: false, status: "Could not save: disk full" })
    expect(failed.request).toBeUndefined()
    expect(failed.dirty).toBe(true)
  })

  it("acts on the row that is on screen after a save removes one", () => {
    // The cursor is remembered per view, so a save that drops `Save & exit`
    // would otherwise leave it pointing one row past the end.
    const onSave = press(start(), "c", "down", "down")
    const saved = { ...applied(press(onSave, "return"), { saved: true, status: "Saved." }), quitAfterSave: false }
    delete saved.request
    expect(menuRows(saved)).toEqual(["control", "employees", "exit"])
    expect(press(saved, "return").request).toBe("quit")
  })

  it("leaves from the Exit row", () => {
    const rows = menuRows(start())
    const onExit = press(start(), ...Array<string>(rows.length - 1).fill("down"))
    expect(rows[onExit.cursor.menu]).toBe("exit")
    expect(press(onExit, "return").request).toBe("quit")
  })
})

describe("navigation", () => {
  it("walks the employee list and wraps at both ends", () => {
    expect(press(employees(), "down").cursor.employees).toBe(1)
    expect(press(employees(), "down", "down", "down").cursor.employees).toBe(0)
    expect(press(employees(), "up").cursor.employees).toBe(ROSTER.length - 1)
  })

  it("accepts j and k as well as the arrows", () => {
    expect(press(employees(), "j", "j").cursor.employees).toBe(2)
    expect(press(employees(), "j", "k").cursor.employees).toBe(0)
  })

  it("drills from the list into an employee and on into the model picker", () => {
    const state = press(employees(), "down", "return")
    expect(state.view).toBe("employee")
    expect(state.employeeId).toBe("malik-johnson")

    const picker = press(state, "return")
    expect(picker.view).toBe("models")
  })

  it("unwinds one view at a time with esc, and only the menu ends the session", () => {
    const picker = press(employees(), "return", "return")
    expect(picker.view).toBe("models")
    const employee = press(picker, "escape")
    expect(employee.view).toBe("employee")
    const list = press(employee, "escape")
    expect(list.view).toBe("employees")
    const menu = press(list, "escape")
    expect(menu.view).toBe("menu")
    expect(menu.request).toBeUndefined()
    expect(press(menu, "escape").request).toBe("quit")
  })

  it("always opens an employee on the Model row", () => {
    // Model is what a user came for nine times out of ten, so the row cursor
    // resets rather than remembering where they last were.
    const state = press(employees(), "return", "down")
    expect(state.cursor.employee).toBe(1)
    expect(press(state, "escape", "return").cursor.employee).toBe(0)
  })

  it("jumps between vendor groups with tab and shift+tab", () => {
    const picker = press(employees(), "return", "return")
    const first = press(picker, "tab")
    expect(pickerEntries(first)[first.cursor.models]?.providerLabel).toBe("Anthropic")
    const second = press(first, "tab")
    expect(pickerEntries(second)[second.cursor.models]?.providerLabel).toBe("OpenAI")
    const back = press(second, { name: "tab", shift: true })
    expect(pickerEntries(back)[back.cursor.models]?.providerLabel).toBe("Anthropic")
  })
})

describe("host targets", () => {
  it("loads one target catalogue only after that target is opened", () => {
    let state = targets({}, {})
    expect(state.view).toBe("targets")
    expect(state.catalogues).toEqual({})

    state = press(state, "return")
    expect(state.view).toBe("models")
    expect(state.targetId).toBe("opencode:default")
    expect(state.request).toBe("catalogue")

    state = catalogueApplied(state, "opencode:default", TARGET_CATALOGUES["opencode:default"]!)
    expect(state.request).toBeUndefined()
    expect(pickerEntries(state).map((entry) => entry.model?.id)).toEqual([
      undefined,
      "github-copilot/claude-opus-5",
    ])
  })

  it("configures Copilot honestly as recorded but not applied to children", () => {
    const seats: SeatsConfig = {
      control: true,
      employees: {
        "arjun-mehta": {
          targets: {
            "copilot:default": { host: "copilot" },
            "opencode:default": {
              host: "opencode",
              model: "github-copilot/claude-opus-5",
              options: [{ id: "variant", value: "medium" }],
            },
          },
        },
      },
    }
    let state = press(targets(seats), "down", "down")
    expect(render(state, { rows: 40, columns: 120 }).join("\n")).toContain("empty - choose a model or remove")

    state = press(state, "return", "down", "return")
    expect(state.view).toBe("options")
    expect(state.seats.employees["arjun-mehta"]?.targets?.["copilot:default"]).toEqual({
      host: "copilot",
      model: "claude-opus-5",
    })
    state = press(state, "right")
    expect(state.seats.employees["arjun-mehta"]?.targets?.["copilot:default"]?.options).toEqual([
      { id: "reasoningEffort", value: "low" },
    ])
    expect(diagnoseSeats(state.seats).issues.map((issue) => issue.code)).not.toContain("empty-target")
    state = press(state, "escape", "escape")
    expect(render(state, { rows: 40, columns: 120 }).join("\n")).toContain("not applied to children")
  })

  it("labels Codex child control experimental", () => {
    let state = press(targets(), "down", "return", "down", "return")
    expect(state.view).toBe("options")
    expect(state.seats.employees["arjun-mehta"]?.targets?.["codex:default"]?.model).toBe("gpt-5.6-sol")
    state = press(state, "escape", "escape")
    expect(state.view).toBe("targets")
    expect(render(state, { rows: 40, columns: 120 }).join("\n")).toContain("experimental")
  })

  it("clears options the newly selected model does not offer", () => {
    const seats: SeatsConfig = {
      control: true,
      employees: {
        "arjun-mehta": {
          targets: {
            "copilot:default": {
              host: "copilot",
              model: "claude-opus-5",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
          },
        },
      },
    }
    const state = press(targets(seats), "down", "down", "return", "down", "return")
    expect(state.seats.employees["arjun-mehta"]?.targets?.["copilot:default"]).toEqual({
      host: "copilot",
      model: "claude-haiku-4.5",
    })
  })

  it("preserves options when the catalogue does not know the model", () => {
    const seats: SeatsConfig = {
      control: true,
      employees: {
        "arjun-mehta": {
          targets: {
            "copilot:default": {
              host: "copilot",
              model: "future-model",
              options: [{ id: "futureOption", value: "kept", metadata: 42 }],
            },
          },
        },
      },
    }
    const state = press(targets(seats), "down", "down", "return", "return")
    expect(state.seats.employees["arjun-mehta"]?.targets?.["copilot:default"]?.options).toEqual([
      { id: "futureOption", value: "kept", metadata: 42 },
    ])
  })

  it("does not report a target as applied when its key and stored host disagree", () => {
    const seats: SeatsConfig = {
      control: true,
      employees: {
        "arjun-mehta": {
          targets: {
            "opencode:default": { host: "copilot", model: "claude-opus-5" },
          },
        },
      },
    }
    const output = render(targets(seats), { rows: 40, columns: 120 }).join("\n")
    expect(output).toContain("not applied to children")
    expect(output).not.toContain("claude-opus-5          applied")
  })

  it("unwinds options through models and targets one level at a time", () => {
    let state = press(targets(), "down", "return", "down", "return")
    expect(state.view).toBe("options")
    state = press(state, "escape")
    expect(state.view).toBe("models")
    state = press(state, "escape")
    expect(state.view).toBe("targets")
    state = press(state, "escape")
    expect(state.view).toBe("employee")
  })

  it("removes an empty target and the warning reported for it", () => {
    const seats: SeatsConfig = {
      control: true,
      employees: {
        "arjun-mehta": {
          targets: {
            "copilot:default": { host: "copilot" },
            "opencode:default": { host: "opencode", model: "github-copilot/claude-opus-5" },
          },
        },
      },
    }
    const state = press(targets(seats), "down", "down", "d")
    expect(state.seats.employees["arjun-mehta"]?.targets?.["copilot:default"]).toBeUndefined()
    expect(render(state, { rows: 40, columns: 120 }).join("\n")).not.toContain("This target sets nothing")
  })

  it("lists unsupported targets in report mode instead of flattening them into OpenCode", () => {
    const seats: SeatsConfig = {
      control: true,
      employees: {
        "arjun-mehta": {
          targets: { "copilot:default": { host: "copilot", model: "claude-opus-5" } },
        },
      },
    }
    const report = renderReport(seats, ROSTER, TARGET_PROFILES).join("\n")
    expect(report).toContain("copilot:default")
    expect(report).toContain("claude-opus-5")
    expect(report).toContain("not applied to children")
  })

  it("lists targets for unknown employee ids in report mode", () => {
    const seats: SeatsConfig = {
      control: true,
      employees: {
        "arjun-metha": {
          targets: { "codex:default": { host: "codex", model: "gpt-5.6-sol" } },
        },
      },
    }
    const report = renderReport(seats, ROSTER, TARGET_PROFILES).join("\n")
    expect(report).toContain("arjun-metha (not on the roster)")
    expect(report).toContain("codex:default")
    expect(report).toContain("gpt-5.6-sol")
  })
})

describe("effort", () => {
  it("cycles through exactly what the highlighted model declares, and wraps", () => {
    // Haiku stops at high. Its cycle is off, low, medium, high.
    const at = (state: ConfigUIState): string | undefined => state.draftVariant
    let state = press(employees(), "return", "return", ...Array<string>(HAIKU).fill("down"))
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
    const picker = press(employees(), "return", "return")
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
    const state = press(employees(), "return", "return", ...Array<string>(NANO).fill("down"), "right")
    expect(state.draftVariant).toBeUndefined()
    expect(state.status).toBe("GPT-5 Nano takes no reasoning effort, so there is nothing to cycle through.")
  })

  it("says the same for a model with no reasoning mechanisms at all", () => {
    const state = press(employees(), "return", "return", ...Array<string>(GPT4O).fill("down"), "right")
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
    const state = press(employees(), "return", "return", ...Array<string>(SONNET).fill("down"))
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
    const onSonnet = press(employees(), "return", "return", ...Array<string>(SONNET).fill("down"))
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
    let state = press(employees(), "return", "return", "down")
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
    let state = press(employees(), "return", "return", ...Array<string>(OPUS).fill("down"), "left")
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
    let state = press(employees(), "return", "return", ...Array<string>(OPUS).fill("down"), "left")
    expect(state.draftVariant).toBe("max")
    state = press(state, "tab")
    expect(pickerEntries(state)[state.cursor.models]?.model?.id).toBe("openai/gpt-5-nano")
    expect(state.draftVariant).toBeUndefined()
    expect(state.status).toContain('does not offer "max" effort')
  })

  it("clears the armed effort on the way back to the inherit row", () => {
    const state = press(employees(), "return", "return", ...Array<string>(OPUS).fill("down"), "left", "up")
    expect(pickerEntries(state)[state.cursor.models]?.kind).toBe("inherit")
    expect(state.draftVariant).toBeUndefined()
  })

  it("treats the suggestion list as a guess for a model it does not know", () => {
    let state = press(employees(), "return", "return", "m")
    state = type(state, "someone/exotic-model")
    state = press(state, "return")
    expect(state.seats.employees["arjun-mehta"]?.targets?.["opencode:default"]?.model).toBe(
      "someone/exotic-model",
    )

    // Re-opening the picker on an unknown model still offers a scale, flagged.
    const reopened = press(state, "return")
    expect(effortCycle(reopened).known).toBe(false)
    expect(press(reopened, "right").status).toContain("suggestions")
  })
})

describe("assigning a model", () => {
  it("writes an OpenCode target instead of ignored legacy fields", () => {
    const seats: SeatsConfig = {
      control: true,
      employees: {
        "arjun-mehta": {
          model: "anthropic/ignored",
          variant: "high",
          targets: { "opencode:default": { host: "opencode" } },
        },
      },
    }
    const state = press(
      into(initialState({ seats, roster: ROSTER, models: MODELS })),
      "return",
      "return",
      ...Array<string>(OPUS).fill("down"),
      "right",
      "return",
    )
    const seat = state.seats.employees["arjun-mehta"]

    expect(seat?.model).toBeUndefined()
    expect(seat?.variant).toBeUndefined()
    expect(seat?.targets).toEqual({
      "opencode:default": {
        host: "opencode",
        model: "anthropic/claude-opus-4-8",
        options: [{ id: "variant", value: "low" }],
      },
    })
    expect(diagnoseSeats(state.seats).issues.map((issue) => issue.code)).not.toContain("legacy-fields-shadowed")
    expect(diagnoseSeats(state.seats).issues.map((issue) => issue.code)).not.toContain("empty-target")
    const output = render(state, { rows: 40, columns: 100 }).join("\n")
    expect(output).not.toContain('older "model" and "variant" fields are ignored')
    expect(output).not.toContain("This target sets nothing")
  })

  it("writes the model onto the seat and returns to the employee view", () => {
    const state = press(employees(), "return", "return", ...Array<string>(OPUS).fill("down"), "return")
    expect(state.view).toBe("employee")
    expect(state.seats.employees["arjun-mehta"]).toEqual({
      targets: {
        "opencode:default": {
          host: "opencode",
          model: "anthropic/claude-opus-4-8",
        },
      },
    })
    expect(state.dirty).toBe(true)
  })

  it("commits the model and the effort together", () => {
    const state = press(employees(), "return", "return", ...Array<string>(OPUS).fill("down"), "right", "return")
    expect(state.seats.employees["arjun-mehta"]).toEqual({
      targets: {
        "opencode:default": {
          host: "opencode",
          model: "anthropic/claude-opus-4-8",
          options: [{ id: "variant", value: "low" }],
        },
      },
    })
  })

  it("drops the effort when the model goes back to inherit", () => {
    const assigned = press(employees(), "return", "return", ...Array<string>(OPUS).fill("down"), "right", "return")
    const cleared = press(assigned, "return", "up", "return")
    expect(cleared.seats.employees["arjun-mehta"]).toBeUndefined()
    expect(cleared.status).toContain("the effort was dropped with it")
  })

  it("cannot produce a variant with no model, however you drive it", () => {
    // The property the whole picker is shaped around: model and variant are
    // written by one action, so this UI can never author the config
    // `diagnoseSeats` warns about.
    const states = [
      press(employees(), "return", "return", "right", "return"),
      press(employees(), "return", "return", "down", "right", "return", "return", "up", "return"),
      press(employees(), "return", "return", "down", "left", "return"),
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
    const picker = press(into(initialState({ seats, roster: ROSTER, models: MODELS })), "return", "return")
    expect(picker.cursor.models).toBe(HAIKU)
    expect(picker.draftVariant).toBe("medium")
  })

  it("shows a configured model the catalogue cannot describe, rather than hiding it behind inherit", () => {
    // Otherwise the cursor would sit on "inherit" while the seat plainly names
    // a model, which reads as "your model is gone".
    const seats: SeatsConfig = { control: true, employees: { "arjun-mehta": { model: "bedrock/anthropic.claude-v9" } } }
    const picker = press(into(initialState({ seats, roster: ROSTER, models: MODELS })), "return", "return")
    const entry = pickerEntries(picker)[picker.cursor.models]
    expect(picker.cursor.models).toBe(1)
    expect(entry?.model?.id).toBe("bedrock/anthropic.claude-v9")
    expect(entry?.model?.known).toBe(false)
    expect(render(picker, { rows: 40, columns: 100 }).join("\n")).toContain("bedrock (not in the catalogue)")
  })

  it("takes a hand-typed provider/model when the catalogue cannot help", () => {
    const empty = initialState({ seats: { control: false, employees: {} }, roster: ROSTER, models: [] })
    let state = press(into(empty), "return", "return", "m")
    state = type(state, "bedrock/some-model")
    state = press(state, "return")
    expect(state.seats.employees["arjun-mehta"]?.targets?.["opencode:default"]?.model).toBe(
      "bedrock/some-model",
    )
  })

  it("stores a malformed model rather than swallowing it, and lets the OpenCode diagnosis say why", () => {
    /**
     * The oracle moved, the behaviour did not. `provider/model` is OpenCode
     * policy rather than a fact about models — applied to every host it failed
     * Codex's `gpt-5.6-sol` and Grok's `grok-build` — so `diagnoseSeats` no
     * longer raises it and `diagnoseOpencodeSeats` does. Both assertions below
     * are unchanged: the seat still stores what was typed, the finding is
     * still an `error`, and the TUI still renders its sentence verbatim.
     */
    let state = press(employees(), "return", "return", "m")
    state = type(state, "claude-opus")
    state = press(state, "return")
    expect(state.seats.employees["arjun-mehta"]?.targets?.["opencode:default"]?.model).toBe("claude-opus")
    const issue = diagnoseOpencodeSeats(state.seats).find((entry) => entry.code === "malformed-model")
    expect(issue?.severity).toBe("error")
    expect(collapse(render(state, { rows: 40, columns: 100 }).join("\n"))).toContain(collapse(issue!.message))
  })

  it("discards a half-typed model on esc", () => {
    let state = press(employees(), "return", "return", "m")
    state = type(state, "half")
    state = press(state, "escape")
    expect(state.entry).toBeUndefined()
    expect(state.seats.employees["arjun-mehta"]).toBeUndefined()
  })

  it("backspaces inside a text field", () => {
    let state = press(employees(), "return", "return", "m")
    state = type(state, "abc")
    state = press(state, "backspace")
    expect(state.entry?.value).toBe("ab")
  })
})

describe("filtering", () => {
  it("narrows the picker and resets the cursor to the top", () => {
    let state = press(employees(), "return", "return", "down", "down", "/")
    state = type(state, "haiku")
    state = press(state, "return")
    expect(state.filter).toBe("haiku")
    expect(state.cursor.models).toBe(0)
    expect(pickerEntries(state)).toHaveLength(2)
  })

  it("says nothing matched rather than showing an empty box", () => {
    let state = press(employees(), "return", "return", "/")
    state = type(state, "zzz")
    state = press(state, "return")
    expect(render(state, { rows: 40, columns: 100 }).join("\n")).toContain('Nothing matches "zzz"')
  })
})

describe("skills", () => {
  it("adds comma-separated skills to the seat", () => {
    let state = press(employees(), "return", "down", "return")
    state = type(state, "react, accessibility")
    state = press(state, "return")
    expect(state.seats.employees["arjun-mehta"]?.skills).toEqual([
      { name: "react", description: "" },
      { name: "accessibility", description: "" },
    ])
  })

  it("says out loud that skills do not depend on seat control", () => {
    let state = press(employees(), "return", "down", "return")
    state = type(state, "react")
    state = press(state, "return")
    expect(state.status).toContain("whether or not seat control is on")
  })

  it("clears skills when the field is emptied", () => {
    const seats: SeatsConfig = { control: false, employees: { "arjun-mehta": { skills: [{ name: "react", description: "" }] } } }
    let state = press(into(initialState({ seats, roster: ROSTER, models: MODELS })), "return", "down", "return")
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
    const state = press(into(initialState({ seats, roster: ROSTER, models: MODELS })), "return", "down", "down", "return")
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
    const state = press(into(initialState({ seats, roster: ROSTER, models: MODELS })), "return", "return", "up", "return")
    expect(state.seats.employees["arjun-mehta"]).toEqual({ temperature: 0.2 })
  })

  it("does nothing, loudly, when there is no seat to reset", () => {
    const state = press(employees(), "return", "down", "down", "return")
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
    let state = press(employees(), "return", "return", "m")
    state = type(state, "half-typed")
    expect(reduce(state, { name: "c", ctrl: true, sequence: "\u0003" }).request).toBe("quit")
  })

  it("does not treat ctrl+a as text", () => {
    const state = press(employees(), "return", "return", "m")
    expect(reduce(state, { name: "a", ctrl: true, sequence: "\u0001" }).entry?.value).toBe("")
  })

  it("returns the same state object for a key that does nothing", () => {
    const state = start()
    expect(reduce(state, { name: "z", sequence: "z" })).toBe(state)
  })
})

describe("render", () => {
  const viewport = { rows: 30, columns: 100 }

  const menu = initialState({
    seats: {
      control: false,
      employees: { "arjun-mehta": { model: "anthropic/claude-opus-4-8", variant: "high", skills: [{ name: "react", description: "" }] } },
    },
    roster: ROSTER,
    models: MODELS,
  })
  /** The same config, one level in, where the roster table is drawn. */
  const seated = into(menu)

  it("emits no ANSI colour unless it is handed a theme", () => {
    // Plain by default is what keeps a pipe, a screen reader and every
    // assertion in this file reading the same text the terminal draws.
    for (const state of [menu, seated, press(seated, "return"), press(seated, "return", "return")]) {
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
    expect(row.indexOf("anthropic")).toBe(header!.indexOf("Model"))
  })

  it("says on every screen whether seat control is on and whether anything is in effect", () => {
    for (const state of [menu, seated, press(seated, "return"), press(seated, "return", "return")]) {
      const text = render(state, viewport).join("\n")
      expect(text).toContain("Seat control        off - model and effort are inert; skills still apply")
      // The seated fixture has skills, and skills are not gated on control, so
      // this config does change something even with control off.
      expect(text).toContain("Right now           this config changes what runs")
    }

    const modelOnly = initialState({
      seats: { control: false, employees: { "arjun-mehta": { model: "anthropic/claude-opus-4-8" } } },
      roster: ROSTER,
      models: MODELS,
    })
    expect(render(modelOnly, viewport).join("\n")).toContain("Right now           this config changes nothing")

    const on = render({ ...menu, seats: { ...menu.seats, control: true } }, viewport).join("\n")
    expect(on).toContain("Seat control        on - Observer sets the model and effort")
    expect(on).toContain("Right now           this config changes what runs")
  })

  it("puts seat control on screen as a row you can press, not just a key you have to know", () => {
    const lines = render(menu, viewport)
    const row = lines.find((line) => line.startsWith("> Seat control"))
    expect(row).toBeDefined()
    expect(row).toContain("off")
    expect(lines.some((line) => line.includes("Employees") && line.includes("3 people"))).toBe(true)
  })

  it("names the one host that can honour any of this, on the row that owns the flag", () => {
    // The narrowings are too long to sit on every screen, so they expand under
    // the cursor — which starts on Seat control, where they belong.
    expect(render(menu, viewport).join("\n")).toContain(
      "OpenCode only - Codex, Claude Code and Copilot CLI are not seated",
    )
  })

  it("says seat control reaches `general` delegations only, in observer doctor's words", () => {
    /**
     * The second narrowing, and it is not cosmetic.
     *
     * Seating works by rewriting `subagent_type`, and doing that to a
     * specialised agent would throw away its own prompt, tools and
     * deny-by-default permissions — so only `general` delegations are ever
     * reseated. A UI that named the host but not the agent type would leave a
     * user believing every subagent they see moves onto the model they just
     * picked. `observer doctor` already says this sentence; the wording is
     * copied rather than reworded so the two cannot drift.
     */
    const text = collapse(render(menu, viewport).join("\n"))
    expect(text).toContain(
      collapse("`general` delegations only - any other agent keeps its own prompt, tools and model"),
    )
  })

  it("walks a new user through the first two steps, and stops once they are taken", () => {
    const fresh = initialState({ seats: { control: false, employees: {} }, roster: ROSTER, models: MODELS })
    expect(render(fresh, viewport).join("\n")).toContain("Getting started")
    // Either half of the setup done is enough to retire it.
    expect(render(press(fresh, "c"), viewport).join("\n")).not.toContain("Getting started")
    expect(render(menu, viewport).join("\n")).not.toContain("Getting started")
  })

  it("wraps a value into the gutter rather than clipping the end off it", () => {
    // The sentences in this block exist to be read in full; "...keeps its own
    // prompt, tools and mo..." is worse than two lines.
    for (const columns of [60, 80, 100, 160]) {
      const text = collapse(render(menu, { rows: 30, columns }).join("\n"))
      expect(text).toContain(collapse("any other agent keeps its own prompt, tools and model"))
    }
  })

  it("renders diagnoseSeats sentences verbatim rather than rewording them", () => {
    const broken = into(
      initialState({
        seats: { control: false, employees: { "malik-johnson": { variant: "high" } } },
        roster: ROSTER,
        models: MODELS,
      }),
    )
    const issue = diagnoseSeats(broken.seats).issues.find((entry) => entry.code === "variant-without-model")!
    const text = render(broken, viewport).join("\n")
    // Wrapped across lines, so compare on collapsed whitespace.
    expect(collapse(text)).toContain(collapse(issue.message))
    expect(text).toContain("warning:")
  })

  it("flags the row of a seat with a finding, in the gutter", () => {
    const broken = into(
      initialState({
        seats: { control: false, employees: { "malik-johnson": { variant: "high" } } },
        roster: ROSTER,
        models: MODELS,
      }),
    )
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
    const lines = render(press(into(empty), "return", "return"), viewport)
    expect(lines.join("\n")).toContain("No models to list.")
    expect(lines.join("\n")).toContain("m type a model")
  })

  it("keeps the key hints when the terminal is too short for the list", () => {
    const lines = render(seated, { rows: 12, columns: 100 })
    expect(lines[lines.length - 1]).toContain("esc back")
    expect(lines.length).toBeLessThanOrEqual(24)
  })

  it("keeps every column readable at 80 columns", () => {
    const lines = render(seated, { rows: 30, columns: 80 })
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(80)
    expect(lines.find((line) => line.includes("Arjun Mehta"))).toContain("high")
  })

  it("shows where you are once you are more than one level in", () => {
    expect(render(press(seated, "return"), viewport).join("\n")).toContain("Employees > Arjun Mehta")
    expect(render(press(seated, "return", "return"), viewport).join("\n")).toContain(
      "Employees > Arjun Mehta > Model",
    )
  })

  it("changes the hints with the view", () => {
    expect(render(menu, viewport).at(-1)).toContain("c toggle seat control")
    expect(render(menu, viewport).at(-1)).toContain("esc quit")
    expect(render(seated, viewport).at(-1)).toContain("enter configure")
    expect(render(press(seated, "return"), viewport).at(-1)).toContain("enter change")
    expect(render(press(seated, "return", "return"), viewport).at(-1)).toContain("left/right effort")
    expect(render(press(press(menu, "c"), "escape"), viewport).at(-1)).toContain("s save and quit")
  })
})

describe("colour", () => {
  const viewport = { rows: 30, columns: 100 }
  const themed = { ...viewport, theme: buildTheme("truecolor") }

  const state = initialState({
    seats: { control: true, employees: { "arjun-mehta": { model: "anthropic/claude-opus-4-8", variant: "high" } } },
    roster: ROSTER,
    models: MODELS,
  })

  it("paints from the Forgeline palette when a theme is passed", () => {
    const text = render(state, themed).join("\n")
    // Emerald Volt on the flag that is on, Electric Violet on the title.
    expect(text).toContain("\u001B[38;2;20;184;48m")
    expect(text).toContain("\u001B[38;2;108;36;228m")
  })

  it("falls back to the nearest xterm slot when the terminal is only 256 colours", () => {
    const text = render(state, { ...viewport, theme: buildTheme("256") }).join("\n")
    expect(text).toContain("\u001B[38;5;35m")
    expect(text).not.toMatch(/38;2;/)
  })

  it("says everything in words as well as in colour", () => {
    // Colour repeats a distinction, never carries one: strip it and the same
    // text is left.
    const plain = render(state, viewport).join("\n")
    expect(strip(render(state, themed).join("\n"))).toBe(plain)
  })

  it("keeps columns aligned once cells are painted", () => {
    const rows = render(into(state), themed).filter((line) => line.includes("Arjun Mehta"))
    const widths = render(into(state), viewport)
      .filter((line) => line.includes("Arjun Mehta"))
      .map((line) => line.length)
    expect(rows.map((line) => strip(line).length)).toEqual(widths)
  })

  it("never leaves a style unclosed when a line is clipped", () => {
    // 60 columns is the floor the renderer works to; anything narrower is
    // drawn at 60 and left to the terminal to wrap.
    for (const columns of [40, 60, 80]) {
      for (const line of render(into(state), { rows: 30, columns, theme: buildTheme("truecolor") })) {
        expect(strip(line).length).toBeLessThanOrEqual(Math.max(60, columns))
        if (line.includes("\u001B[")) expect(line.endsWith("\u001B[0m")).toBe(true)
      }
    }
  })
})

describe("colorSupport", () => {
  it("honours NO_COLOR above everything else", () => {
    expect(colorSupport({ NO_COLOR: "1", COLORTERM: "truecolor" }, true)).toBe("plain")
    // An empty NO_COLOR is not a request, by the convention's own wording.
    expect(colorSupport({ NO_COLOR: "" }, true)).not.toBe("plain")
  })

  it("refuses colour without a terminal, so a pipe gets plain text", () => {
    expect(colorSupport({}, false)).toBe("plain")
    expect(colorSupport({ TERM: "dumb" }, true)).toBe("plain")
  })

  it("takes 24-bit colour only when the terminal claims it", () => {
    expect(colorSupport({ COLORTERM: "truecolor" }, true)).toBe("truecolor")
    expect(colorSupport({ TERM: "xterm-direct" }, true)).toBe("truecolor")
    expect(colorSupport({ TERM: "xterm-256color" }, true)).toBe("256")
  })

  it("lets FORCE_COLOR override the TTY check in both directions", () => {
    expect(colorSupport({ FORCE_COLOR: "1" }, false)).toBe("256")
    expect(colorSupport({ FORCE_COLOR: "0", COLORTERM: "truecolor" }, true)).toBe("plain")
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

/** The text a terminal draws, with the colour taken back off. */
function strip(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, "")
}

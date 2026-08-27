import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { migrateSeatSpecToTargets } from "@observer-ai/daemon"
import { seatAgentDir, seatAgentName, syncSeatAgents, uninstall } from "../dist/index.js"

let home: string
let originalHome: string | undefined
let originalXdg: string | undefined
let originalCache: string | undefined
let originalData: string | undefined
let originalObserverHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer-seat-agents-"))
  originalHome = process.env["HOME"]
  originalXdg = process.env["XDG_CONFIG_HOME"]
  originalCache = process.env["XDG_CACHE_HOME"]
  originalData = process.env["XDG_DATA_HOME"]
  originalObserverHome = process.env["OBSERVER_HOME"]
  process.env["HOME"] = home
  // Observer's own data directory is redirected too: a test must never read or
  // write the config of the developer running it.
  process.env["OBSERVER_HOME"] = join(home, ".observer")
  delete process.env["XDG_CONFIG_HOME"]
  // The variant check reads OpenCode's model catalogue and auth file, both of
  // which resolve under XDG before HOME. Redirecting HOME alone would leave a
  // developer's real 7,000-model catalogue deciding what these tests assert on
  // Windows, where `homedir()` does not follow the `HOME` environment variable.
  process.env["XDG_CACHE_HOME"] = join(home, ".cache")
  process.env["XDG_DATA_HOME"] = join(home, ".local", "share")
})

afterEach(() => {
  restore("HOME", originalHome)
  restore("XDG_CONFIG_HOME", originalXdg)
  restore("XDG_CACHE_HOME", originalCache)
  restore("XDG_DATA_HOME", originalData)
  restore("OBSERVER_HOME", originalObserverHome)
  rmSync(home, { recursive: true, force: true })
})

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** A seats config, spelled the way a user's config.json holds it. */
function seats(control: boolean, employees: Record<string, Record<string, unknown>> = {}): any {
  return { control, employees }
}

/**
 * Writes a model catalogue where OpenCode keeps its own.
 *
 * Shaped exactly like `~/.cache/opencode/models.json`: provider -> models ->
 * `reasoning_options`, the mechanism list models.dev publishes.
 */
function catalogue(raw: string): void {
  const directory = join(home, ".cache", "opencode")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "models.json"), raw)
}

const CATALOGUE = JSON.stringify({
  anthropic: {
    name: "Anthropic",
    models: {
      // Declares a graded effort scale, so the catalogue can rule on a variant.
      "claude-opus-4-5": {
        name: "Claude Opus 4.5",
        tool_call: true,
        limit: { context: 200_000 },
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      },
      // Declares no reasoning at all. Verified against a live host across all
      // 3,506 models in this shape: every one of them rejects every variant.
      "claude-haiku-4-5": { name: "Claude Haiku 4.5", tool_call: true, limit: { context: 200_000 } },
      // Declares a mechanism OpenCode synthesises variants from, without an
      // effort scale. The catalogue cannot rule on it, so the host must.
      "claude-sonnet-4-5": {
        name: "Claude Sonnet 4.5",
        tool_call: true,
        limit: { context: 200_000 },
        reasoning_options: [{ type: "budget_tokens", min: 1024 }],
      },
    },
  },
})

function agentFiles(): string[] {
  const directory = seatAgentDir()
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((file) => {
      const contents = readFileSync(join(directory, file), "utf8")
      return !contents.includes("observer:employee-agent v1") || /^model:/m.test(contents)
    })
    .sort()
}

function employeeAgentFiles(): string[] {
  const directory = seatAgentDir()
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((file) => readFileSync(join(directory, file), "utf8").includes("observer:employee-agent v1")).sort()
}

function read(file: string): string {
  return readFileSync(join(seatAgentDir(), file), "utf8")
}

const ARJUN = { model: "anthropic/claude-opus-4-5", variant: "high" }

describe("seatAgentName", () => {
  it("prefixes a roster id and leaves an already-slug-shaped id alone", () => {
    expect(seatAgentName("arjun-mehta")).toBe("observer-arjun-mehta")
    expect(seatAgentName("dr-mei-lin")).toBe("observer-dr-mei-lin")
  })

  it("produces a name the plugin's title join still accepts", () => {
    /**
     * Copied from `SUBAGENT_TITLE_SUFFIX` in observer-plugin.js. OpenCode titles
     * a child session `<description> (@<agent> subagent)` and the plugin strips
     * that to find the delegation the child belongs to. A generated name the
     * regex cannot match would leave every seated node without its employee,
     * silently — so the naming rule is pinned here as well as in the plugin.
     */
    const SUBAGENT_TITLE_SUFFIX = /\s*\(\s*@?[\w.\-]+\s+subagent\s*\)\s*$/i
    for (const id of ["arjun-mehta", "dr-mei-lin", "Weird Id!!", "", "...."]) {
      const name = seatAgentName(id)
      const title = `Audit the build (@${name} subagent)`
      expect(title.replace(SUBAGENT_TITLE_SUFFIX, ""), name).toBe("Audit the build")
    }
  })

  it("never produces a name that could escape the agent directory", () => {
    expect(seatAgentName("../../etc/passwd")).toBe("observer-etc-passwd")
    expect(seatAgentName("a b/c")).toBe("observer-a-b-c")
    expect(seatAgentName("")).toBe("observer-unknown")
  })

})

describe("syncSeatAgents", () => {
  it("writes one definition per seat that sets a model", () => {
    const result = syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))

    expect(agentFiles()).toEqual(["observer-arjun-mehta.md"])
    expect(employeeAgentFiles()).toHaveLength(14)
    expect(result.written).toHaveLength(14)
    expect(result.removed).toEqual([])

    const contents = read("observer-arjun-mehta.md")
    expect(contents).toContain("mode: subagent")
    expect(contents).not.toContain("hidden: true")
    expect(contents).toContain(`model: "anthropic/claude-opus-4-5"`)
    expect(contents).toContain(`variant: "high"`)
    expect(contents).toContain("Arjun Mehta")
  })

  it("makes nested delegation and peer coordination explicit in every employee definition", () => {
    /**
     * Employee definitions must carry this contract themselves. Depending on
     * the config hook made the live registry vary by caller and left employees
     * unable to staff children even though Observer exposed agent_spawn.
     */
    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    const contents = read("observer-arjun-mehta.md")
    expect(contents).toContain("permission:")
    expect(contents).toContain(`  todowrite: "deny"`)
    expect(contents).toContain(`  task: "allow"`)
    expect(contents).toContain(`  agent_spawn: "allow"`)
    expect(contents).toContain(`  agent_send: "allow"`)
  })

  it("puts the employee behavior in the native agent body", () => {
    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    const [, body] = read("observer-arjun-mehta.md").split(/^---$/m).slice(1)
    expect(body).toContain("You are Arjun Mehta")
    expect(body).toContain("observer-sofia-moreno")
    expect(body).toContain("Interaction design")
  })

  it("writes no file for a seat that sets a reasoning effort but no model", () => {
    // OpenCode applies a variant only to an agent's own configured model, so a
    // file with a variant and nothing else could not do anything.
    const result = syncSeatAgents(seats(true, { "arjun-mehta": { variant: "high" } }))
    expect(agentFiles()).toEqual([])
    expect(result.written).toHaveLength(14)
    expect(result.notes.join("\n")).toContain("has no effect without a model")
  })

  it("writes no file for an employee who is not on the roster", () => {
    const result = syncSeatAgents(seats(true, { "nobody-at-all": ARJUN }))
    expect(agentFiles()).toEqual([])
    expect(result.notes.join("\n")).toContain("not an employee on the roster")
  })

  it("writes no file for a model that is missing its provider", () => {
    // The file would load, appear in the host's agent list, pass the plugin's
    // existence check, and only then fail the delegation. Not writing it turns
    // a broken task into a no-op.
    const result = syncSeatAgents(seats(true, { "arjun-mehta": { model: "claude-opus-4-5" } }))
    expect(agentFiles()).toEqual([])
    expect(result.notes.join("\n")).toContain("missing its provider")
  })

  it("writes nothing and removes a previous run's files when control is off", () => {
    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN, "malik-johnson": { model: "openai/gpt-5" } }))
    expect(agentFiles()).toHaveLength(2)
    expect(employeeAgentFiles()).toHaveLength(14)

    // The seats survive in the config; only the flag changed. Turning the
    // feature off has to stop it billing the user for a model they no longer
    // asked for, which means the files have to go.
    const result = syncSeatAgents(seats(false, { "arjun-mehta": ARJUN, "malik-johnson": { model: "openai/gpt-5" } }))
    expect(agentFiles()).toEqual([])
    expect(result.written).toHaveLength(2)
    expect(result.removed).toEqual([])
    expect(result.notes.join("\n")).toContain("Seat control is off")
  })

  it("is idempotent: a second run writes and removes nothing", () => {
    const config = seats(true, { "arjun-mehta": ARJUN })
    syncSeatAgents(config)
    const before = read("observer-arjun-mehta.md")

    const second = syncSeatAgents(config)
    expect(second.written).toEqual([])
    expect(second.removed).toEqual([])
    expect(agentFiles()).toEqual(["observer-arjun-mehta.md"])
    expect(read("observer-arjun-mehta.md")).toBe(before)
    // The count still has to be reported: a caller printing `written.length`
    // after a no-op save would claim nothing is in force.
    expect(second.notes.join("\n")).toContain("14 employee agent definitions available")
  })

  it("removes a definition once its seat drops the model", () => {
    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    const result = syncSeatAgents(seats(true, { "arjun-mehta": { variant: "high" } }))
    expect(agentFiles()).toEqual([])
    expect(result.written).toEqual([join(seatAgentDir(), "observer-arjun-mehta.md")])
    expect(result.removed).toEqual([])
  })

  it("rewrites a definition that no longer matches its seat", () => {
    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    const result = syncSeatAgents(seats(true, { "arjun-mehta": { model: "openai/gpt-5", variant: "low" } }))
    expect(result.written).toHaveLength(1)
    expect(read("observer-arjun-mehta.md")).toContain(`model: "openai/gpt-5"`)
    expect(read("observer-arjun-mehta.md")).toContain(`variant: "low"`)
  })

  it("omits the variant entirely when the seat does not set one", () => {
    syncSeatAgents(seats(true, { "arjun-mehta": { model: "openai/gpt-5" } }))
    expect(read("observer-arjun-mehta.md")).not.toContain("variant:")
  })

  it("keeps a file Observer did not write, through a sync and an uninstall", () => {
    const directory = seatAgentDir()
    mkdirSync(directory, { recursive: true })
    // Named exactly like a generated file, but without Observer's marker.
    writeFileSync(join(directory, "observer-notes.md"), "---\ndescription: mine\n---\nhand written\n")
    writeFileSync(join(directory, "observer.md"), "---\ndescription: the @observer mention\n---\n")

    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    expect(agentFiles()).toEqual(["observer-arjun-mehta.md", "observer-notes.md", "observer.md"])

    syncSeatAgents(seats(false))
    expect(agentFiles()).toEqual(["observer-notes.md", "observer.md"])

    uninstall("opencode")
    expect(readFileSync(join(directory, "observer-notes.md"), "utf8")).toContain("hand written")
  })

  it("adopts a generated file whose marker a user removed", () => {    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    const path = join(seatAgentDir(), "observer-arjun-mehta.md")
    // Deleting the marker line is the documented way to take ownership of a
    // generated file. Observer must then leave it alone rather than delete it.
    writeFileSync(path, readFileSync(path, "utf8").replace(/^# observer:employee-agent.*$/m, "# mine now"))

    const result = syncSeatAgents(seats(false))
    expect(result.removed).toEqual([])
    expect(existsSync(path)).toBe(true)
  })

  it("quotes values that would otherwise break the frontmatter", () => {
    syncSeatAgents(seats(true, { "arjun-mehta": { model: `weird/model: "x"`, variant: "a: b" } }))
    const contents = read("observer-arjun-mehta.md")
    expect(contents).toContain(`model: "weird/model: \\"x\\""`)
    expect(contents).toContain(`variant: "a: b"`)
  })

  it("says that seat control pins models without forcing delegation", () => {
    const result = syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    expect(result.notes.join("\n")).toContain("Restart OpenCode")
    expect(result.notes.join("\n")).toContain("does not force OpenCode to use an employee")
  })

  it("honours XDG_CONFIG_HOME", () => {
    process.env["XDG_CONFIG_HOME"] = join(home, "custom-config")
    expect(seatAgentDir()).toBe(join(home, "custom-config", "opencode", "agent"))
    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    expect(existsSync(join(home, "custom-config", "opencode", "agent", "observer-arjun-mehta.md"))).toBe(true)
  })

  it("creates the full roster even when no model pins are configured", () => {
    syncSeatAgents(seats(true))
    expect(employeeAgentFiles()).toHaveLength(14)
  })

  it("survives a config whose seats section is missing or malformed", () => {
    for (const value of [undefined, null, {}, { control: true }, { control: true, employees: null }]) {
      expect(() => syncSeatAgents(value as any)).not.toThrow()
    }
  })
})

describe("syncSeatAgents: variants the model does not declare", () => {
  it("WRITES NO FILE FOR A REASONING EFFORT THE MODEL DOES NOT OFFER", () => {
    /**
     * The second half of the same bug the provider check closed.
     *
     * OpenCode validates `variant` per model at *use* time, not at load time —
     * `if (x.variant && !R.variants?.[x.variant]) fail(...)`. So `xhigh` on a
     * model offering only low/medium/high writes a valid file, loads, appears
     * in `GET /agent`, passes the plugin's existence check, and only then kills
     * the delegation. That is exactly the outcome the existence check exists to
     * prevent, so it gets the same remedy: no file, and a sentence saying why.
     */
    catalogue(CATALOGUE)
    const result = syncSeatAgents(seats(true, { "arjun-mehta": { model: "anthropic/claude-opus-4-5", variant: "xhigh" } }))

    expect(agentFiles()).toEqual([])
    expect(result.written).toHaveLength(14)
    expect(result.notes.join("\n")).toContain(`"xhigh" is not one anthropic/claude-opus-4-5 offers (low, medium, high)`)
  })

  it("writes normally for a reasoning effort the model does declare", () => {
    catalogue(CATALOGUE)
    const result = syncSeatAgents(seats(true, { "arjun-mehta": { model: "anthropic/claude-opus-4-5", variant: "medium" } }))

    expect(agentFiles()).toEqual(["observer-arjun-mehta.md"])
    expect(read("observer-arjun-mehta.md")).toContain(`variant: "medium"`)
    expect(result.notes.join("\n")).not.toContain("is not one")
  })

  it("writes for a model the catalogue has never heard of, whatever the variant", () => {
    // An unknown model is not a wrong model. The catalogue is a snapshot and
    // the host is the authority; refusing here would break a user whose
    // provider ships faster than models.dev.
    catalogue(CATALOGUE)
    const result = syncSeatAgents(seats(true, { "arjun-mehta": { model: "exotic/model-9", variant: "xhigh" } }))

    expect(agentFiles()).toEqual(["observer-arjun-mehta.md"])
    expect(read("observer-arjun-mehta.md")).toContain(`variant: "xhigh"`)
    expect(result.notes.join("\n")).not.toContain("is not one")
  })

  it("writes when there is no catalogue at all", () => {
    // Nothing was written to ~/.cache/opencode. Silence is not a verdict.
    const result = syncSeatAgents(seats(true, { "arjun-mehta": { model: "anthropic/claude-opus-4-5", variant: "xhigh" } }))

    expect(agentFiles()).toEqual(["observer-arjun-mehta.md"])
    expect(result.notes.join("\n")).not.toContain("is not one")
  })

  it("writes when the catalogue is corrupt", () => {
    catalogue("{ this is not json")
    syncSeatAgents(seats(true, { "arjun-mehta": { model: "anthropic/claude-opus-4-5", variant: "xhigh" } }))
    expect(agentFiles()).toEqual(["observer-arjun-mehta.md"])
  })

  it("writes when the model declares a mechanism the catalogue cannot read an effort scale off", () => {
    /**
     * The rule that keeps this check from doing more harm than good.
     *
     * OpenCode synthesises variants for the `toggle` and `budget_tokens`
     * mechanisms, so a model can accept `high` while publishing no effort
     * scale. `variantsFor` reports those as unknown rather than empty, and an
     * unknown model is not a wrong model: write it and let the host rule.
     */
    catalogue(CATALOGUE)
    syncSeatAgents(seats(true, { "arjun-mehta": { model: "anthropic/claude-sonnet-4-5", variant: "high" } }))
    expect(agentFiles()).toEqual(["observer-arjun-mehta.md"])
  })

  it("writes no file for a model that takes no reasoning effort at all", () => {
    // The other side of the same coin. A model with no reasoning mechanism
    // rejects every variant, so this is a verdict rather than silence and the
    // seat has to be skipped — otherwise the delegation fails at use time.
    catalogue(CATALOGUE)
    const result = syncSeatAgents(seats(true, { "arjun-mehta": { model: "anthropic/claude-haiku-4-5", variant: "high" } }))

    expect(agentFiles()).toEqual([])
    expect(result.notes.join("\n")).toContain("takes no reasoning effort")
  })

  it("does not consult the catalogue for a seat that sets no variant", () => {
    // A model with nothing to validate is written on the strength of its own
    // seat. The catalogue below would have plenty to say about `xhigh`; there
    // is no `xhigh` to say it about.
    catalogue(CATALOGUE)
    syncSeatAgents(seats(true, { "arjun-mehta": { model: "anthropic/claude-opus-4-5" } }))
    expect(agentFiles()).toEqual(["observer-arjun-mehta.md"])
  })

  it("removes a definition once its seat gains a variant the model does not offer", () => {
    // The skip has to reconcile, not just decline: a file left behind from the
    // last good config would keep passing the plugin's existence check and keep
    // failing the delegation.
    catalogue(CATALOGUE)
    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    expect(agentFiles()).toEqual(["observer-arjun-mehta.md"])

    const result = syncSeatAgents(seats(true, { "arjun-mehta": { model: "anthropic/claude-opus-4-5", variant: "xhigh" } }))
    expect(agentFiles()).toEqual([])
    expect(result.written).toEqual([join(seatAgentDir(), "observer-arjun-mehta.md")])
    expect(result.removed).toEqual([])
    // The skipped seat must still speak: the TUI prints `notes`, so a seat that
    // produced no note would vanish from the user's view entirely.
    expect(result.notes.join("\n")).toContain("is not one anthropic/claude-opus-4-5 offers")
  })

  it("skips only the seat at fault, and leaves its colleagues in force", () => {
    catalogue(CATALOGUE)
    const result = syncSeatAgents(
      seats(true, {
        "arjun-mehta": { model: "anthropic/claude-opus-4-5", variant: "xhigh" },
        "malik-johnson": { model: "anthropic/claude-opus-4-5", variant: "high" },
      }),
    )

    expect(agentFiles()).toEqual(["observer-malik-johnson.md"])
    expect(result.notes.join("\n")).toContain("14 employee agent definitions available")
  })
})

/**
 * The gap ticket 01 opened and ticket 02 closes.
 *
 * `seats.employees.<id>.targets` became the shape a save writes, but this
 * module still read `spec.model` and `spec.variant`. A seat configured with
 * `targets` therefore generated no agent file at all, the plugin's existence
 * check missed, and seat control silently did nothing for that employee — with
 * no error anywhere. Every test below is a claim about that: a seat written in
 * target form must reach exactly the file the legacy form reached.
 *
 * Parity is asserted byte-for-byte rather than field-by-field. The file is the
 * contract with OpenCode, and "contains the right model" would pass on a file
 * whose frontmatter had quietly lost `permission: todowrite: deny`.
 */
describe("syncSeatAgents: seats written as targets", () => {
  /** The same assignment as `ARJUN`, spelled the way ticket 01's schema stores it. */
  const ARJUN_TARGET = {
    targets: {
      "opencode:default": {
        host: "opencode",
        model: "anthropic/claude-opus-4-5",
        options: [{ id: "variant", value: "high" }],
      },
    },
  }

  /** The generated file for one seat spec, with the directory left clean. */
  function generate(spec: Record<string, unknown>): { files: string[]; contents: string | undefined; notes: string } {
    const result = syncSeatAgents(seats(true, { "arjun-mehta": spec }))
    const files = agentFiles()
    const contents = files.includes("observer-arjun-mehta.md") ? read("observer-arjun-mehta.md") : undefined
    // Reconcile back to empty so the next call in a test starts from nothing.
    syncSeatAgents(seats(false))
    return { files, contents, notes: result.notes.join("\n") }
  }

  it("PRODUCES A BYTE-IDENTICAL FILE TO THE EQUIVALENT LEGACY SEAT", () => {
    const legacy = generate(ARJUN)
    const target = generate(ARJUN_TARGET)

    expect(legacy.contents, "the legacy seat must still generate a file").toBeTruthy()
    expect(target.files).toEqual(["observer-arjun-mehta.md"])
    expect(target.contents).toBe(legacy.contents)
  })

  it("is byte-identical for a target with no options, like a legacy seat with no variant", () => {
    const legacy = generate({ model: "openai/gpt-5" })
    const target = generate({ targets: { "opencode:default": { host: "opencode", model: "openai/gpt-5" } } })

    expect(target.contents).toBe(legacy.contents)
    expect(target.contents).not.toContain("variant:")
  })

  it("reads a target filed under any key, not just the legacy one", () => {
    // The key is user-chosen — `seatTargets` says so explicitly — so keying the
    // lookup on `opencode:default` would drop a perfectly good seat.
    const target = generate({
      targets: { "opencode:work": { host: "opencode", model: "anthropic/claude-opus-4-5", options: [{ id: "variant", value: "high" }] } },
    })
    expect(target.files).toEqual(["observer-arjun-mehta.md"])
    expect(target.contents).toBe(generate(ARJUN).contents)
  })

  it("honours the targets and ignores the shadowed legacy pair", () => {
    /**
     * The expensive silent bug `seatTargets` exists to prevent. A half-migrated
     * seat carries both, `targets` is the newer statement, and honouring
     * `model` instead would put the user on a model they had already replaced —
     * visible only on a bill.
     */
    const target = generate({ model: "openai/gpt-5", variant: "low", ...ARJUN_TARGET })
    expect(target.contents).toBe(generate(ARJUN).contents)
    expect(target.contents).not.toContain("gpt-5")
  })

  it("writes nothing for a target that names another host", () => {
    // This module writes OpenCode agent definitions and nothing else. A Codex
    // model id has no slash and must not be run through OpenCode's rule.
    const codex = generate({ targets: { "codex:default": { host: "codex", model: "gpt-5.6-sol" } } })
    expect(codex.files).toEqual([])
    expect(codex.notes).not.toContain("missing its provider")
  })

  it("writes the OpenCode target and leaves a sibling host's target alone", () => {
    const both = generate({
      targets: {
        "codex:default": { host: "codex", model: "gpt-5.6-sol" },
        "opencode:default": ARJUN_TARGET.targets["opencode:default"],
      },
    })
    expect(both.contents).toBe(generate(ARJUN).contents)
  })

  it("writes no file for a target whose model is missing its provider", () => {
    // The slash rule now lives in the OpenCode adapter and is applied to the
    // target's path, not just the legacy field.
    const target = generate({ targets: { "opencode:default": { host: "opencode", model: "claude-opus-4-5" } } })
    expect(target.files).toEqual([])
    expect(target.notes).toContain("missing its provider")
  })

  it("writes no file for a target whose options have no model to apply to", () => {
    const target = generate({ targets: { "opencode:default": { host: "opencode", options: [{ id: "variant", value: "high" }] } } })
    expect(target.files).toEqual([])
    // Parity with the legacy `variant-without-model` sentence: a seat that
    // produces no file has to say why, whichever shape it was written in.
    expect(target.notes).toContain("has no effect without a model")
  })

  it("writes no file for a target whose variant its model does not declare", () => {
    catalogue(CATALOGUE)
    const target = generate({
      targets: { "opencode:default": { host: "opencode", model: "anthropic/claude-opus-4-5", options: [{ id: "variant", value: "xhigh" }] } },
    })
    expect(target.files).toEqual([])
    expect(target.notes).toContain(`"xhigh" is not one anthropic/claude-opus-4-5 offers (low, medium, high)`)
  })

  it("drops a variant whose value is a boolean rather than writing it out", () => {
    // `variant` names an effort level. `variant: "true"` is not a lenient
    // reading of a mistyped toggle, it is a value guaranteed to fail the
    // delegation — so the option is dropped and the model still applies.
    const target = generate({
      targets: { "opencode:default": { host: "opencode", model: "openai/gpt-5", options: [{ id: "variant", value: true }] } },
    })
    expect(target.contents).toBe(generate({ model: "openai/gpt-5" }).contents)
    expect(target.contents).not.toContain("variant:")
  })

  it("ignores an option the adapter does not know", () => {
    const target = generate({
      targets: {
        "opencode:default": {
          host: "opencode",
          model: "openai/gpt-5",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "variant", value: "low" },
          ],
        },
      },
    })
    expect(target.contents).toBe(generate({ model: "openai/gpt-5", variant: "low" }).contents)
  })

  it("writes no file for a target whose host Observer does not drive", () => {
    const target = generate({ targets: { "openkode:default": { host: "openkode", model: "anthropic/claude-opus-4-5" } } })
    expect(target.files).toEqual([])
    expect(target.notes).toContain("is not a host Observer drives")
  })

  it("writes no file for a target on a seat that is not on the roster", () => {
    const result = syncSeatAgents(seats(true, { "nobody-at-all": ARJUN_TARGET }))
    expect(agentFiles()).toEqual([])
    expect(result.notes.join("\n")).toContain("not an employee on the roster")
  })

  it("applies one OpenCode target per employee and says so when there are two", () => {
    // A generated definition is named per employee, so two OpenCode profiles on
    // one seat cannot both have a file. Silently picking a winner would leave a
    // user watching their second profile do nothing with no way to find out why.
    const target = generate({
      targets: {
        "opencode:default": ARJUN_TARGET.targets["opencode:default"],
        "opencode:work": { host: "opencode", model: "openai/gpt-5" },
      },
    })
    expect(target.files).toEqual(["observer-arjun-mehta.md"])
    expect(target.contents).toContain(`model: "anthropic/claude-opus-4-5"`)
    expect(target.notes).toContain(`only "opencode:default" was applied`)
  })

  it("removes a legacy seat's file once the seat migrates to a target that sets no model", () => {
    // Reconciliation has to survive the migration: a file left behind from the
    // legacy shape would keep passing the plugin's existence check.
    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    expect(agentFiles()).toEqual(["observer-arjun-mehta.md"])

    const result = syncSeatAgents(seats(true, { "arjun-mehta": { targets: { "opencode:default": { host: "opencode" } } } }))
    expect(agentFiles()).toEqual([])
    expect(result.written).toEqual([join(seatAgentDir(), "observer-arjun-mehta.md")])
    expect(result.removed).toEqual([])
  })

  it("rewrites nothing when a legacy seat is migrated to the equivalent target", () => {
    /**
     * The strongest form of the parity claim. `migrateSeatSpecToTargets`
     * rewrites a saved config in place; if the two shapes disagreed by so much
     * as a byte, the very next sync would rewrite every generated file and
     * every OpenCode watching that directory would see churn for a change the
     * user never made.
     */
    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    const second = syncSeatAgents(seats(true, { "arjun-mehta": ARJUN_TARGET }))

    expect(second.written).toEqual([])
    expect(second.removed).toEqual([])
    expect(second.notes.join("\n")).toContain("14 employee agent definitions available")
  })

  it("agrees with migrateSeatSpecToTargets, so a save cannot change what is on disk", () => {
    // The parity above is only worth anything if the migration produces the
    // shape this module reads. Pinning the two together is what stops a future
    // change to either from silently un-seating every migrated config.
    const migrated = migrateSeatSpecToTargets({ ...ARJUN }) as Record<string, unknown>
    expect(migrated).toEqual(ARJUN_TARGET)
    expect(generate(migrated).contents).toBe(generate(ARJUN).contents)
  })
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { NEUTRAL_AGENT_TYPES, seatAgentDir, seatAgentName, syncSeatAgents, uninstall } from "../dist/index.js"

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
  // developer's real 7,000-model catalogue deciding what these tests assert.
  delete process.env["XDG_CACHE_HOME"]
  delete process.env["XDG_DATA_HOME"]
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
  return readdirSync(directory).sort()
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

  it("agrees exactly with the copy of the rule inside the OpenCode plugin", () => {
    /**
     * The naming rule necessarily exists twice: the plugin is dependency-free
     * plain JavaScript copied verbatim into the user's config directory and
     * cannot import this module. If the two drift, the installer writes one
     * name and the plugin asks for another, the existence check misses, and
     * seat control silently stops working — with no error anywhere. Comments
     * on both sides say so; this is what actually enforces it.
     */
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "integrations", "opencode", "observer-plugin.js"),
      "utf8",
    )
    const body = /function seatAgentName\(employeeId\) \{[\s\S]*?\n\}/.exec(source)?.[0]
    expect(body, "seatAgentName not found in observer-plugin.js").toBeTruthy()
    const fromPlugin = new Function(`${body}; return seatAgentName`)() as (id: string) => string

    for (const id of ["arjun-mehta", "dr-mei-lin", "Weird Id!!", "", "....", "../../etc/passwd", "a_b.c"]) {
      expect(fromPlugin(id), id).toBe(seatAgentName(id))
    }
  })
})

describe("NEUTRAL_AGENT_TYPES", () => {
  it("agrees exactly with the allow-list the OpenCode plugin enforces", () => {
    /**
     * The list exists twice for the same reason `seatAgentName` does, but the
     * consequence of drift is worse. The plugin is what actually declines a
     * rewrite; this copy is only what the installer *tells* the user it
     * declines. If the plugin's list grew an entry this one did not, Observer
     * would be silently replacing a specialised agent — losing its prompt and
     * its tool restrictions — while printing a note swearing it only touches
     * `general`.
     */
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "integrations", "opencode", "observer-plugin.js"),
      "utf8",
    )
    const literal = /const NEUTRAL_AGENT_TYPES = new Set\((\[[^\]]*\])\)/.exec(source)?.[1]
    expect(literal, "NEUTRAL_AGENT_TYPES not found in observer-plugin.js").toBeTruthy()
    const fromPlugin = new Function(`return ${literal}`)() as string[]

    expect(fromPlugin).toEqual([...NEUTRAL_AGENT_TYPES])
  })

  it("is `general` and only `general`", () => {
    // Pinned deliberately. `general` is the only built-in that ships with no
    // prompt and no tool restriction, which is what makes swapping it for a
    // generated seat agent lossless. Adding an entry here is a decision about
    // safety, not a refactor, and this line is where it gets noticed.
    expect([...NEUTRAL_AGENT_TYPES]).toEqual(["general"])
  })
})

describe("syncSeatAgents", () => {
  it("writes one definition per seat that sets a model", () => {
    const result = syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))

    expect(agentFiles()).toEqual(["observer-arjun-mehta.md"])
    expect(result.written).toEqual([join(seatAgentDir(), "observer-arjun-mehta.md")])
    expect(result.removed).toEqual([])

    const contents = read("observer-arjun-mehta.md")
    expect(contents).toContain("mode: subagent")
    expect(contents).toContain("hidden: true")
    expect(contents).toContain(`model: "anthropic/claude-opus-4-5"`)
    expect(contents).toContain(`variant: "high"`)
    expect(contents).toContain("Arjun Mehta")
  })

  it("denies todowrite, so the generated agent is not more permissive than `general`", () => {
    /**
     * The allow-list only replaces `general`, and that is only defensible if
     * the replacement is lossless. It very nearly was: a bare generated agent
     * differed from `general` by exactly one permission — `general` denies
     * `todowrite` and the generated one did not, so seating an employee
     * silently *granted* a delegated subagent the right to rewrite the parent
     * session's todo list. Verified against a live `opencode serve`: with this
     * line, `GET /agent` reports identical permission sets for the two.
     */
    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    const contents = read("observer-arjun-mehta.md")
    expect(contents).toContain("permission:")
    expect(contents).toContain(`  todowrite: "deny"`)
  })

  it("leaves the body empty so the agent keeps the prompt a built-in subagent gets", () => {
    // OpenCode sets `prompt` to the trimmed file body and then uses it only when
    // truthy, falling back to the provider default — which is exactly what the
    // built-in `general` agent does, because it ships with no prompt either. An
    // empty body is therefore how a generated agent stays a plain worker; the
    // persona reaches it through the task prompt instead.
    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    const [, body] = read("observer-arjun-mehta.md").split(/^---$/m).slice(1)
    expect(body?.trim()).toBe("")
  })

  it("writes no file for a seat that sets a reasoning effort but no model", () => {
    // OpenCode applies a variant only to an agent's own configured model, so a
    // file with a variant and nothing else could not do anything.
    const result = syncSeatAgents(seats(true, { "arjun-mehta": { variant: "high" } }))
    expect(agentFiles()).toEqual([])
    expect(result.written).toEqual([])
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

    // The seats survive in the config; only the flag changed. Turning the
    // feature off has to stop it billing the user for a model they no longer
    // asked for, which means the files have to go.
    const result = syncSeatAgents(seats(false, { "arjun-mehta": ARJUN, "malik-johnson": { model: "openai/gpt-5" } }))
    expect(agentFiles()).toEqual([])
    expect(result.written).toEqual([])
    expect(result.removed).toHaveLength(2)
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
    expect(second.notes.join("\n")).toContain("1 seat agent definition in force")
  })

  it("removes a definition once its seat drops the model", () => {
    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    const result = syncSeatAgents(seats(true, { "arjun-mehta": { variant: "high" } }))
    expect(agentFiles()).toEqual([])
    expect(result.removed).toEqual([join(seatAgentDir(), "observer-arjun-mehta.md")])
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
    writeFileSync(path, readFileSync(path, "utf8").replace(/^# observer:seat-agent.*$/m, "# mine now"))

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

  it("says out loud that permission prompts change, and what seat control applies to", () => {
    // The one visible behaviour change of turning seat control on, and the main
    // reason it defaults off. It has to be printed where a user will see it.
    const result = syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    expect(result.notes.join("\n")).toContain("ask permission as `observer-<employee>`")
    expect(result.notes.join("\n")).toContain("Restart OpenCode")
    // A user who sets a model and watches `explore` keep running the session's
    // model deserves the reason in the same breath as the promise.
    expect(result.notes.join("\n")).toContain("`general` delegations only")
    expect(result.notes.join("\n")).toContain("keeps that agent's own prompt, tools and model")
  })

  it("honours XDG_CONFIG_HOME", () => {
    process.env["XDG_CONFIG_HOME"] = join(home, "custom-config")
    expect(seatAgentDir()).toBe(join(home, "custom-config", "opencode", "agent"))
    syncSeatAgents(seats(true, { "arjun-mehta": ARJUN }))
    expect(existsSync(join(home, "custom-config", "opencode", "agent", "observer-arjun-mehta.md"))).toBe(true)
  })

  it("creates no directory at all when there is nothing to write", () => {
    syncSeatAgents(seats(true))
    expect(existsSync(seatAgentDir())).toBe(false)
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
    expect(result.written).toEqual([])
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
    expect(result.removed).toEqual([join(seatAgentDir(), "observer-arjun-mehta.md")])
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
    expect(result.notes.join("\n")).toContain("1 seat agent definition in force")
  })
})

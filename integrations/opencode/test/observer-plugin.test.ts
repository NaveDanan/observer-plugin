import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The plugin ships as dependency-free plain JavaScript so it can be copied
// verbatim into ~/.config/opencode/plugin. It is exercised here through its
// real hook surface rather than through a wrapper.
// @ts-expect-error -- untyped plain-JS plugin, loaded on purpose
import { ObserverPlugin } from "../observer-plugin.js"

interface Delivery {
  event: string
  payload: Record<string, any>
  context: Record<string, any>
}

interface SessionRecord {
  id: string
  parentID?: string
  title?: string
}

interface Harness {
  hooks: any
  deliveries: Delivery[]
  /** Deliveries for one event kind, most recent last. */
  of(event: string): Delivery[]
  /** How many times the plugin asked the host for its agent list. */
  agentListCalls(): number
  flush(): Promise<void>
}

let home: string
let originalHome: string | undefined
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "observer-oc-plugin-"))
  writeFileSync(join(home, "config.json"), JSON.stringify({ port: 7788, token: "t0k3n" }))
  originalHome = process.env["OBSERVER_HOME"]
  process.env["OBSERVER_HOME"] = home
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalHome === undefined) delete process.env["OBSERVER_HOME"]
  else process.env["OBSERVER_HOME"] = originalHome
  rmSync(home, { recursive: true, force: true })
})

/** The agents a stock OpenCode reports before Observer generates anything. */
const STOCK_AGENTS = ["build", "plan", "general", "explore"]

async function harness(
  options: {
    sessions?: Record<string, SessionRecord>
    /** Sessions whose lookup fails, standing in for an unreachable host. */
    unreachable?: string[]
    seat?: { id: string; directive: string; score: number }
    guidance?: boolean
    /** The `seats` section of ~/.observer/config.json. */
    seats?: { control?: boolean; employees?: Record<string, Record<string, unknown>> }
    /** Agent names the host reports. Defaults to a stock OpenCode. */
    agents?: string[]
    /** Make the agent listing fail, standing in for an unreachable host. */
    agentsUnavailable?: boolean
  } = {},
): Promise<Harness> {
  const sessions = options.sessions ?? {}
  const unreachable = new Set(options.unreachable ?? [])
  const seat = options.seat ?? { id: "malik-johnson", directive: "Be calm and direct.", score: 9 }

  if (options.guidance === false || options.seats) {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        port: 7788,
        token: "t0k3n",
        ...(options.guidance === false ? { guidance: false } : {}),
        ...(options.seats ? { seats: options.seats } : {}),
      }),
    )
  }

  const deliveries: Delivery[] = []
  globalThis.fetch = (async (url: any, init?: any) => {
    const href = String(url)
    if (href.endsWith("/v1/hooks")) {
      const body = JSON.parse(String(init?.body ?? "{}"))
      for (const delivery of body.deliveries ?? []) deliveries.push(delivery)
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }
    if (href.endsWith("/v1/roster/match")) {
      return Response.json({ matches: [seat] })
    }
    if (href.endsWith("/v1/roster")) {
      return Response.json({ profiles: [{ fullName: "Malik Johnson", title: "Staff Backend Engineer", fields: ["APIs"] }] })
    }
    return new Response("{}", { status: 404 })
  }) as typeof globalThis.fetch

  let agentListCalls = 0
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        if (unreachable.has(path.id)) throw new Error("host unreachable")
        const record = sessions[path.id]
        if (!record) throw new Error("no such session")
        return { data: record }
      },
    },
    // `client.app.agents()` is the host's own agent registry — the same one the
    // task tool fails against with "Unknown agent type". A filesystem check
    // would pass for a file the host has not loaded, so this is the only
    // answer worth trusting.
    app: {
      agents: async () => {
        agentListCalls++
        if (options.agentsUnavailable) throw new Error("host unreachable")
        return { data: (options.agents ?? STOCK_AGENTS).map((name: string) => ({ name, mode: "subagent" })) }
      },
    },
  }

  const hooks = await ObserverPlugin({ client, directory: "/repo", worktree: "/repo" })
  return {
    hooks,
    deliveries,
    of: (event: string) => deliveries.filter((delivery) => delivery.event === event),
    agentListCalls: () => agentListCalls,
    flush: async () => {
      await hooks.dispose()
    },
  }
}

/**
 * A task-tool call as OpenCode really makes it. The agent parameter is
 * `subagent_type`: the harness must spell it the way the host does, otherwise
 * it proves nothing about the code path that runs in production.
 */
const taskCall = (sessionID: string, callID: string, description: string, prompt: string, subagentType = "general") => ({
  input: { tool: "task", sessionID, callID },
  output: { args: { description, prompt, subagent_type: subagentType } as Record<string, any> },
})

const toolPart = (sessionID: string, callID: string, description: string, prompt: string) => ({
  type: "message.part.updated",
  properties: {
    part: {
      type: "tool",
      id: `prt_${callID}`,
      callID,
      sessionID,
      messageID: "msg_1",
      tool: "task",
      state: { status: "running", input: { description, prompt } },
    },
  },
})

/** The same task part later in its life, when only the status matters. */
const finishedToolPart = (sessionID: string, callID: string, status: string) => ({
  type: "message.part.updated",
  properties: {
    part: {
      type: "tool",
      id: `prt_${callID}`,
      callID,
      sessionID,
      messageID: "msg_1",
      tool: "task",
      state: { status },
    },
  },
})

const sessionCreated = (info: SessionRecord) => ({ type: "session.created", properties: { info } })

/** The heading of the roster brief the plugin appends to the system prompt. */
const ROSTER_HEADING = "## Team roster"
/**
 * The extra line that only a manual `@observer` earns. Guidance alone briefs the
 * model on who is available; the activation sentence additionally tells it to go
 * looking for work to delegate, so the two must be asserted separately.
 */
const ACTIVATION_SENTENCE = "The user activated Observer staffing with @observer"

/** A user turn as the host hands it to the plugin, with host-assigned part ids. */
const userMessage = (sessionID: string, text: string) => ({
  input: { sessionID },
  output: {
    message: { id: "msg_user_1", sessionID },
    parts: [{ id: "prt_host_1", sessionID, messageID: "msg_user_1", type: "text", text }],
  },
})

describe("observer opencode plugin: seating the roster on child sessions", () => {
  it("joins a child session to its delegation through the decorated title", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = taskCall("root", "call_1", "Audit the build", "Review the CI pipeline for flaky steps")
    await h.hooks["tool.execute.before"](call.input, call.output)

    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.flush()

    const created = h.of("session.created").at(-1)
    expect(created?.context["agentType"]).toBe("malik-johnson")
    expect(created?.context["prompt"]).toBe("Review the CI pipeline for flaky steps")
  })

  it("tolerates the host decorating the title with odd spacing, case and punctuation", async () => {
    const titles = [
      "Audit the build (@general subagent)",
      "Audit the build  ( @Deep-Research_2 Subagent ) ",
      "  Audit   the build  ",
    ]
    for (const title of titles) {
      const h = await harness({ sessions: { root: { id: "root" } } })
      const call = taskCall("root", "call_1", "Audit the build", "prompt text")
      await h.hooks["tool.execute.before"](call.input, call.output)
      await h.hooks.event({ event: sessionCreated({ id: "child", parentID: "root", title }) })
      await h.flush()
      expect(h.of("session.created").at(-1)?.context["agentType"], title).toBe("malik-johnson")
    }
  })

  it("does not seat on a title that merely shares a prefix with a delegation", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build system (@general subagent)" }),
    })
    await h.flush()
    expect(h.of("session.created").at(-1)?.context["agentType"]).toBeUndefined()
  })

  it("records a subcontractor when nobody on the roster fits", async () => {
    const h = await harness({ sessions: { root: { id: "root" } }, seat: { id: "x", directive: "", score: 0 } })
    const call = taskCall("root", "call_1", "Something odd", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Something odd (@general subagent)" }),
    })
    await h.flush()
    expect(h.of("session.created").at(-1)?.context["agentType"]).toBe("subcontractor")
  })
})

describe("observer opencode plugin: the @observer agent is an ack, not work", () => {
  /**
   * Regression: the plugin read `args.subagentType`, but OpenCode's task tool
   * spells the parameter `subagent_type`. The branch never ran, so every
   * @observer activation was seated as an employee and had a persona directive
   * stapled to its prompt. These fail against the camelCase read.
   */
  it("types a delegation to the observer agent as observer, not as an employee", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = taskCall("root", "call_1", "Activate observer", "the user typed @observer", "observer")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Activate observer (@observer subagent)" }),
    })
    await h.flush()
    expect(h.of("session.created").at(-1)?.context["agentType"]).toBe("observer")
  })

  it("leaves the observer agent's prompt free of a persona directive", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = taskCall("root", "call_1", "Activate observer", "the user typed @observer", "observer")
    await h.hooks["tool.execute.before"](call.input, call.output)
    expect(call.output.args["prompt"]).toBe("the user typed @observer")
  })

  it("still seats an ordinary agent type as an employee", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text", "general")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.flush()
    expect(h.of("session.created").at(-1)?.context["agentType"]).toBe("malik-johnson")
  })

  it("honours a camelCase subagentType too, in case a host renames the parameter", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = {
      input: { tool: "task", sessionID: "root", callID: "call_1" },
      output: { args: { description: "Activate observer", prompt: "p", subagentType: "observer" } as Record<string, any> },
    }
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Activate observer (@observer subagent)" }),
    })
    await h.flush()
    expect(h.of("session.created").at(-1)?.context["agentType"]).toBe("observer")
  })
})

describe("observer opencode plugin: delegation bookkeeping is order-independent", () => {
  it("keeps the seated employee when the tool part arrives after the seating", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({ event: toolPart("root", "call_1", "Audit the build", "prompt text") })
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.flush()

    const created = h.of("session.created").at(-1)
    expect(created?.context["agentType"]).toBe("malik-johnson")
    expect(created?.context["prompt"]).toBe("prompt text")
  })

  it("keeps the seated employee when the tool part arrives before the seating", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    await h.hooks.event({ event: toolPart("root", "call_1", "Audit the build", "prompt text") })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.flush()

    const created = h.of("session.created").at(-1)
    expect(created?.context["agentType"]).toBe("malik-johnson")
    expect(created?.context["prompt"]).toBe("prompt text")
  })

  it("carries the prompt on its own when staffing is off and only the tool part is seen", async () => {
    const h = await harness({ sessions: { root: { id: "root" } }, guidance: false })
    // Repeated parts are the same streaming call, not new delegations.
    await h.hooks.event({ event: toolPart("root", "call_1", "Audit the build", "prompt text") })
    await h.hooks.event({ event: toolPart("root", "call_1", "Audit the build", "prompt text") })
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.hooks.event({
      event: sessionCreated({ id: "other", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.flush()

    const created = h.of("session.created")
    expect(created[0]?.context["prompt"]).toBe("prompt text")
    expect(created[0]?.context["agentType"]).toBeUndefined()
    expect(created[1]?.context["prompt"]).toBeUndefined()
  })

  it("gives each of two identical descriptions its own seat", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const first = taskCall("root", "call_1", "Review the diff", "first prompt")
    const second = taskCall("root", "call_2", "Review the diff", "second prompt")
    await h.hooks["tool.execute.before"](first.input, first.output)
    await h.hooks["tool.execute.before"](second.input, second.output)

    await h.hooks.event({
      event: sessionCreated({ id: "child_a", parentID: "root", title: "Review the diff (@general subagent)" }),
    })
    await h.hooks.event({
      event: sessionCreated({ id: "child_b", parentID: "root", title: "Review the diff (@general subagent)" }),
    })
    await h.flush()

    const created = h.of("session.created")
    expect(created.map((delivery) => delivery.context["prompt"])).toEqual(["first prompt", "second prompt"])
    expect(created.every((delivery) => delivery.context["agentType"] === "malik-johnson")).toBe(true)
  })

  it("replays the seating on later updates instead of letting them blank it", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    const info = { id: "child", parentID: "root", title: "Audit the build (@general subagent)" }
    await h.hooks.event({ event: sessionCreated(info) })
    await h.hooks.event({ event: { type: "session.updated", properties: { info } } })
    await h.flush()

    expect(h.of("session.updated").at(-1)?.context["agentType"]).toBe("malik-johnson")
  })

  it("still seats a child session whose title is only filled in on the update", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({ event: sessionCreated({ id: "child", parentID: "root", title: "" }) })
    await h.hooks.event({
      event: {
        type: "session.updated",
        properties: { info: { id: "child", parentID: "root", title: "Audit the build (@general subagent)" } },
      },
    })
    await h.flush()

    expect(h.of("session.created").at(-1)?.context["agentType"]).toBeUndefined()
    expect(h.of("session.updated").at(-1)?.context["agentType"]).toBe("malik-johnson")
  })
})

describe("observer opencode plugin: the finished task call states the subagent finished", () => {
  /**
   * The host's `session.idle` for a child session is not guaranteed, but the
   * `task` call that spawned the child always ends in the parent's message
   * stream. These pin the join from that ending back to the child's node.
   */
  it("reports the child completed when its task call finishes", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.hooks.event({ event: finishedToolPart("root", "call_1", "completed") })
    await h.flush()

    const reported = h.of("observer.agent-status")
    expect(reported).toHaveLength(1)
    expect(reported[0]?.payload).toEqual({ status: "completed" })
    // It lands on the subagent's own node, resolved under the root session.
    expect(reported[0]?.context).toMatchObject({
      sessionKey: "root",
      agentKey: "session:child",
      parentAgentKey: "main",
    })
  })

  it("reports each delegation once even when the host re-sends the finished part", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.hooks.event({ event: finishedToolPart("root", "call_1", "completed") })
    await h.hooks.event({ event: finishedToolPart("root", "call_1", "completed") })
    await h.flush()

    expect(h.of("observer.agent-status")).toHaveLength(1)
  })

  it("reports failed when the task call ends in error", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.hooks.event({ event: finishedToolPart("root", "call_1", "error") })
    await h.flush()

    expect(h.of("observer.agent-status").at(-1)?.payload).toEqual({ status: "failed" })
    expect(h.of("observer.agent-status").at(-1)?.context["agentKey"]).toBe("session:child")
  })

  it("stays silent when no claimed delegation carries the finishing callID", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.hooks.event({ event: finishedToolPart("root", "some_other_call", "completed") })
    await h.flush()

    expect(h.of("observer.agent-status")).toHaveLength(0)
  })

  it("never matches a claim whose callID the backfill could not know", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = {
      input: { tool: "task", sessionID: "root" },
      output: { args: { description: "Audit the build", prompt: "prompt text", subagent_type: "general" } as Record<string, any> },
    }
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.hooks.event({ event: finishedToolPart("root", "call_1", "completed") })
    await h.flush()

    // The claim exists — seating still worked — but with no callID there is
    // nothing exact to join on, so silence beats guessing.
    expect(h.of("session.created").at(-1)?.context["agentType"]).toBe("malik-johnson")
    expect(h.of("observer.agent-status")).toHaveLength(0)
  })

  it("stays silent while the task call is still streaming", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.hooks.event({ event: toolPart("root", "call_1", "Audit the build", "prompt text") })
    await h.hooks.event({ event: finishedToolPart("root", "call_1", "pending") })
    await h.flush()

    expect(h.of("observer.agent-status")).toHaveLength(0)
  })

  it("finishes a nested delegation onto the grandchild's node", async () => {
    const h = await harness({
      sessions: {
        root: { id: "root" },
        child: { id: "child", parentID: "root" },
        grandchild: { id: "grandchild", parentID: "child" },
      },
    })
    const call = taskCall("child", "call_1", "Nested audit", "check the storage layer")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "grandchild", parentID: "child", title: "Nested audit (@general subagent)" }),
    })
    await h.hooks.event({ event: finishedToolPart("child", "call_1", "completed") })
    await h.flush()

    const reported = h.of("observer.agent-status")
    expect(reported.at(-1)?.payload).toEqual({ status: "completed" })
    expect(reported.at(-1)?.context).toMatchObject({
      sessionKey: "root",
      agentKey: "session:grandchild",
      parentAgentKey: "session:child",
    })
  })
})

describe("observer opencode plugin: nesting", () => {
  it("hangs a grandchild off its subagent parent, not off the root agent", async () => {
    const h = await harness({
      sessions: {
        root: { id: "root" },
        child: { id: "child", parentID: "root" },
        grandchild: { id: "grandchild", parentID: "child" },
      },
    })
    await h.hooks.event({ event: sessionCreated({ id: "child", parentID: "root", title: "Level one" }) })
    await h.hooks.event({ event: sessionCreated({ id: "grandchild", parentID: "child", title: "Level two" }) })
    await h.flush()

    const [child, grandchild] = h.of("session.created")
    expect(child?.context).toMatchObject({ sessionKey: "root", agentKey: "session:child", parentAgentKey: "main" })
    expect(grandchild?.context).toMatchObject({
      sessionKey: "root",
      agentKey: "session:grandchild",
      parentAgentKey: "session:child",
    })
  })

  it("keeps a great-grandchild on its own parent at depth three", async () => {
    const h = await harness({
      sessions: {
        root: { id: "root" },
        a: { id: "a", parentID: "root" },
        b: { id: "b", parentID: "a" },
        c: { id: "c", parentID: "b" },
      },
    })
    await h.hooks.event({ event: { type: "todo.updated", properties: { sessionID: "c", todos: [] } } })
    await h.flush()

    expect(h.of("todo.updated").at(-1)?.context).toMatchObject({
      sessionKey: "root",
      agentKey: "session:c",
      parentAgentKey: "session:b",
    })
  })

  it("does not collapse a grandchild onto the root agent when the parent lookup fails", async () => {
    const h = await harness({
      sessions: { root: { id: "root" }, grandchild: { id: "grandchild", parentID: "child" } },
      unreachable: ["child"],
    })
    await h.hooks.event({ event: sessionCreated({ id: "grandchild", parentID: "child", title: "Level two" }) })
    await h.flush()

    const created = h.of("session.created").at(-1)
    expect(created?.context["agentKey"]).toBe("session:grandchild")
    expect(created?.context["parentAgentKey"]).toBe("session:child")
    expect(created?.context["parentAgentKey"]).not.toBe("main")
  })

  it("re-resolves a session it once failed to identify instead of pinning it as a root", async () => {
    const records: Record<string, SessionRecord> = { root: { id: "root" } }
    const unreachable = new Set(["child"])
    const deliveries: Delivery[] = []
    globalThis.fetch = (async (url: any, init?: any) => {
      if (String(url).endsWith("/v1/hooks")) {
        for (const delivery of JSON.parse(String(init?.body ?? "{}")).deliveries ?? []) deliveries.push(delivery)
      }
      return Response.json({})
    }) as typeof globalThis.fetch
    const client = {
      session: {
        get: async ({ path }: { path: { id: string } }) => {
          if (unreachable.has(path.id)) throw new Error("host unreachable")
          const record = records[path.id]
          if (!record) throw new Error("no such session")
          return { data: record }
        },
      },
    }
    const hooks = await ObserverPlugin({ client, directory: "/repo", worktree: "/repo" })

    await hooks.event({ event: { type: "todo.updated", properties: { sessionID: "child", todos: [] } } })
    // The host comes back and can now place the session under its parent.
    unreachable.delete("child")
    records["child"] = { id: "child", parentID: "root" }
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(Date.now() + 6000)
      await hooks.event({ event: { type: "todo.updated", properties: { sessionID: "child", todos: [] } } })
    } finally {
      vi.useRealTimers()
    }
    await hooks.dispose()

    const todos = deliveries.filter((delivery) => delivery.event === "todo.updated")
    expect(todos.at(-1)?.context).toMatchObject({ sessionKey: "root", agentKey: "session:child" })
  })
})

describe("observer opencode plugin: manual activation", () => {
  it("propagates @observer activation down the session tree", async () => {
    const h = await harness({
      guidance: false,
      sessions: {
        root: { id: "root" },
        child: { id: "child", parentID: "root" },
        grandchild: { id: "grandchild", parentID: "child" },
      },
    })
    const parts = [{ type: "text", text: "@observer audit this repo" }]
    await h.hooks["chat.message"]({ sessionID: "root" }, { message: { id: "m1", sessionID: "root" }, parts })

    // A subagent spawning its own subagent must still be seated.
    const call = taskCall("child", "call_1", "Nested audit", "check the storage layer")
    await h.hooks["tool.execute.before"](call.input, call.output)
    await h.hooks.event({
      event: sessionCreated({ id: "grandchild", parentID: "child", title: "Nested audit (@general subagent)" }),
    })
    await h.flush()

    const created = h.of("session.created").at(-1)
    expect(created?.context["agentType"]).toBe("malik-johnson")
    expect(created?.context["parentAgentKey"]).toBe("session:child")
  })

  it("leaves delegations unstaffed when guidance is off and nobody activated observer", async () => {
    const h = await harness({
      guidance: false,
      sessions: { root: { id: "root" }, child: { id: "child", parentID: "root" } },
    })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    expect(call.output.args.prompt).toBe("prompt text")
    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.flush()
    expect(h.of("session.created").at(-1)?.context["agentType"]).toBeUndefined()
  })

  it("briefs a subagent's system prompt once the root session is activated", async () => {
    const h = await harness({
      guidance: false,
      sessions: { root: { id: "root" }, child: { id: "child", parentID: "root" } },
    })
    await h.hooks["chat.message"](
      { sessionID: "root" },
      { message: { id: "m1", sessionID: "root" }, parts: [{ type: "text", text: "@observer" }] },
    )
    const output = { system: ["you are opencode"] }
    await h.hooks["experimental.chat.system.transform"]({ sessionID: "child" }, output)
    await h.flush()

    expect(output.system.join("\n")).toContain("Team roster")
  })

  it("briefs and announces the activation on the same turn @observer was typed, with guidance off", async () => {
    const h = await harness({ guidance: false, sessions: { root: { id: "root" } } })
    const turn = userMessage("root", "@observer take a look at the release pipeline")
    await h.hooks["chat.message"](turn.input, turn.output)

    // The host composes the system prompt after chat.message on the same turn,
    // which is the only reason the activation can still reach the model without
    // the plugin touching the message parts.
    const output = { system: ["you are opencode"] }
    await h.hooks["experimental.chat.system.transform"]({ sessionID: "root" }, output)
    await h.flush()

    expect(output.system.join("\n")).toContain(ROSTER_HEADING)
    expect(output.system.join("\n")).toContain(ACTIVATION_SENTENCE)
  })

  it("stays silent after @observer off even when guidance is enabled globally", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const turn = userMessage("root", "@observer off — I will drive this one myself")
    await h.hooks["chat.message"](turn.input, turn.output)

    // An explicit opt-out outranks the config in the other direction too: the
    // three-state decision must not collapse back to "unset falls through".
    const output = { system: ["you are opencode"] }
    await h.hooks["experimental.chat.system.transform"]({ sessionID: "root" }, output)
    expect(output.system).toEqual(["you are opencode"])

    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    expect(call.output.args.prompt).toBe("prompt text")

    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: "Audit the build (@general subagent)" }),
    })
    await h.flush()
    expect(h.of("session.created").at(-1)?.context["agentType"]).toBeUndefined()
  })

  it("reads @observer off as off even when it is punctuated", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    // People write "@observer off, thanks". A whitespace-or-end boundary made
    // the "off" backtrack away, leaving a bare mention that activated instead.
    const turn = userMessage("root", "@observer off, thanks")
    await h.hooks["chat.message"](turn.input, turn.output)

    const output = { system: ["you are opencode"] }
    await h.hooks["experimental.chat.system.transform"]({ sessionID: "root" }, output)
    await h.flush()

    expect(output.system).toEqual(["you are opencode"])
  })

  it("briefs without the activation sentence when the user never mentioned observer", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const turn = userMessage("root", "please review the release pipeline")
    await h.hooks["chat.message"](turn.input, turn.output)

    // No mention leaves the decision undefined, which must fall through to the
    // enabled guidance config rather than being read as an activation.
    const output = { system: ["you are opencode"] }
    await h.hooks["experimental.chat.system.transform"]({ sessionID: "root" }, output)
    await h.flush()

    expect(output.system.join("\n")).toContain(ROSTER_HEADING)
    expect(output.system.join("\n")).not.toContain(ACTIVATION_SENTENCE)
  })
})

describe("observer opencode plugin: chat.message leaves the host's parts alone", () => {  it("appends no part to an @observer message, because a plugin part has no host id and aborts the turn", async () => {
    const h = await harness({ guidance: false, sessions: { root: { id: "root" } } })
    const turn = userMessage("root", "@observer audit this repo")
    const parts = turn.output.parts
    // The host identifies and normalises every part before calling this hook and
    // validates them against its persisted-part schema afterwards, so a part the
    // plugin appends has no id, sessionID or messageID and makes the save throw.
    const before = structuredClone(parts)

    await h.hooks["chat.message"](turn.input, turn.output)
    await h.flush()

    expect(turn.output.parts).toBe(parts)
    expect(parts).toHaveLength(before.length)
    expect(parts).toEqual(before)
    expect(parts.some((part: any) => part.synthetic)).toBe(false)
  })

  it("appends no part on an ordinary message either, with guidance enabled", async () => {
    const h = await harness({ sessions: { root: { id: "root" } } })
    const turn = userMessage("root", "please review the release pipeline")
    const before = structuredClone(turn.output.parts)

    await h.hooks["chat.message"](turn.input, turn.output)
    await h.flush()

    expect(turn.output.parts).toEqual(before)
    // The user's text still has to reach Observer; only the message is untouched.
    expect(h.of("observer.user-message").at(-1)?.payload["text"]).toBe("please review the release pipeline")
  })
})

describe("observer opencode plugin: seat control", () => {
  /** The generated agent name for the employee the harness always seats. */
  const MALIK = "observer-malik-johnson"
  const CONTROLLED = { control: true, employees: { "malik-johnson": { model: "anthropic/claude-opus-4-5", variant: "high" } } }

  it("points the delegation at the employee's generated agent when the host has it", async () => {
    const h = await harness({ sessions: { root: { id: "root" } }, seats: CONTROLLED, agents: [...STOCK_AGENTS, MALIK] })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)

    // OpenCode's task tool has no model parameter. Rewriting `subagent_type` to
    // an agent whose definition carries the model is the only lever there is.
    expect(call.output.args["subagent_type"]).toBe(MALIK)
  })

  it("LEAVES subagent_type UNTOUCHED WHEN THE GENERATED AGENT IS MISSING", async () => {
    /**
     * The test that stops Observer breaking a session.
     *
     * The task tool does `agents.get(subagent_type)` and fails the delegation
     * outright with "Unknown agent type" when it misses. A definition can be
     * absent for entirely ordinary reasons: the config was edited without
     * re-running the installer, `~/.config/opencode/agent` was cleaned out,
     * OpenCode has not restarted since the files were written, or a dotfiles
     * repo carried the config to a second machine. Every one of those must cost
     * the user their model preference for this task and nothing more.
     */
    const h = await harness({ sessions: { root: { id: "root" } }, seats: CONTROLLED, agents: STOCK_AGENTS })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)

    expect(call.output.args["subagent_type"]).toBe("general")
  })

  it("leaves subagent_type untouched when the host cannot be asked which agents exist", async () => {
    const h = await harness({
      sessions: { root: { id: "root" } },
      seats: CONTROLLED,
      agentsUnavailable: true,
    })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    expect(call.output.args["subagent_type"]).toBe("general")
  })

  it("leaves subagent_type untouched when seat control is off", async () => {
    // The seat still names a model; only the flag is down. Model and effort are
    // inert until the user opts in, which is the whole point of the flag.
    const h = await harness({
      sessions: { root: { id: "root" } },
      seats: { control: false, employees: CONTROLLED.employees },
      agents: [...STOCK_AGENTS, MALIK],
    })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    expect(call.output.args["subagent_type"]).toBe("general")
  })

  it("leaves subagent_type untouched when the config has no seats section at all", async () => {
    const h = await harness({ sessions: { root: { id: "root" } }, agents: [...STOCK_AGENTS, MALIK] })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    expect(call.output.args["subagent_type"]).toBe("general")
  })

  it("leaves subagent_type untouched when the seated employee has no model configured", async () => {
    // A reasoning effort alone is a no-op on OpenCode, so no definition is
    // generated for it and the plugin must not go looking for one.
    const h = await harness({
      sessions: { root: { id: "root" } },
      seats: { control: true, employees: { "malik-johnson": { variant: "high" } } },
      agents: [...STOCK_AGENTS, MALIK],
    })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    expect(call.output.args["subagent_type"]).toBe("general")
  })

  it("leaves subagent_type untouched for an employee nobody configured", async () => {
    const h = await harness({
      sessions: { root: { id: "root" } },
      seats: { control: true, employees: { "arjun-mehta": { model: "anthropic/claude-opus-4-5" } } },
      agents: [...STOCK_AGENTS, MALIK],
    })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    expect(call.output.args["subagent_type"]).toBe("general")
  })

  it("LEAVES A SPECIALISED AGENT ALONE, EVEN THOUGH THE SEAT AND THE DEFINITION ARE BOTH READY", async () => {
    /**
     * The test that stops Observer quietly widening a subagent's permissions.
     *
     * `subagent_type` does not name a model, it names a whole agent definition
     * — prompt, tool permissions, mode. The built-in `explore` ships a
     * specialised prompt *and* a deny-by-default permission set that allows
     * only reads and searches. Swapping it for a
     * generated seat agent would honour the user's model preference by
     * discarding a safety property they never agreed to trade, and would do so
     * with no message anywhere. So only `general` — the one built-in with no
     * prompt and no tool restriction, where the swap changes the model and
     * nothing else — is ever replaced.
     */
    const h = await harness({ sessions: { root: { id: "root" } }, seats: CONTROLLED, agents: [...STOCK_AGENTS, MALIK] })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text", "explore")
    await h.hooks["tool.execute.before"](call.input, call.output)

    expect(call.output.args["subagent_type"]).toBe("explore")
  })

  it("leaves a user-written agent alone", async () => {
    // Observer cannot know what a user put in their own agent file, so it must
    // assume the answer is "something that matters".
    const h = await harness({
      sessions: { root: { id: "root" } },
      seats: CONTROLLED,
      agents: [...STOCK_AGENTS, MALIK, "security-reviewer"],
    })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text", "security-reviewer")
    await h.hooks["tool.execute.before"](call.input, call.output)

    expect(call.output.args["subagent_type"]).toBe("security-reviewer")
  })

  it("still briefs the employee on a delegation it declines to rewrite", async () => {
    // Declining the rewrite costs the user the model for that task. It must not
    // also cost them the persona: the directive rides the prompt, not the agent
    // definition, precisely so it survives every fallback path.
    const h = await harness({ sessions: { root: { id: "root" } }, seats: CONTROLLED, agents: [...STOCK_AGENTS, MALIK] })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text", "explore")
    await h.hooks["tool.execute.before"](call.input, call.output)

    expect(String(call.output.args["prompt"])).toContain("Observer staffing note:")
  })

  it("asks the host nothing at all for a delegation it is not allowed to rewrite", async () => {
    // The allow-list is checked before the agent lookup: a delegation Observer
    // will not touch should cost no loopback request.
    const h = await harness({ sessions: { root: { id: "root" } }, seats: CONTROLLED, agents: [...STOCK_AGENTS, MALIK] })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text", "explore")
    await h.hooks["tool.execute.before"](call.input, call.output)
    expect(h.agentListCalls()).toBe(0)
  })

  it("never rewrites the @observer activation ack", async () => {
    // The ack is not work: it wears no persona and must keep running on
    // whatever the host chose, so it returns before seating is even attempted.
    const h = await harness({ sessions: { root: { id: "root" } }, seats: CONTROLLED, agents: [...STOCK_AGENTS, MALIK] })
    const call = taskCall("root", "call_1", "Activate observer", "the user typed @observer", "observer")
    await h.hooks["tool.execute.before"](call.input, call.output)
    expect(call.output.args["subagent_type"]).toBe("observer")
  })

  it("still joins the child session to its delegation after the rewrite", async () => {
    /**
     * OpenCode titles the child `<description> (@<agent> subagent)` using the
     * name the plugin just wrote. If a generated name did not survive
     * SUBAGENT_TITLE_SUFFIX, seating would keep working right up until control
     * was switched on and then silently stop for every node.
     */
    const h = await harness({ sessions: { root: { id: "root" } }, seats: CONTROLLED, agents: [...STOCK_AGENTS, MALIK] })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)

    await h.hooks.event({
      event: sessionCreated({ id: "child", parentID: "root", title: `Audit the build (@${MALIK} subagent)` }),
    })
    await h.flush()

    expect(h.of("session.created").at(-1)?.context["agentType"]).toBe("malik-johnson")
    expect(h.of("session.created").at(-1)?.context["prompt"]).toBe("prompt text")
  })

  it("appends the persona directive exactly once, whether or not it rewrites", async () => {
    // The directive lives in the prompt, not in the generated agent file. That
    // is what lets it survive the fallback: an employee whose definition is
    // missing still gets briefed, just on the session's own model.
    for (const agents of [[...STOCK_AGENTS, MALIK], STOCK_AGENTS]) {
      const h = await harness({ sessions: { root: { id: "root" } }, seats: CONTROLLED, agents })
      const call = taskCall("root", "call_1", "Audit the build", "prompt text")
      await h.hooks["tool.execute.before"](call.input, call.output)
      const occurrences = String(call.output.args["prompt"]).split("Observer staffing note:").length - 1
      expect(occurrences, agents.join(",")).toBe(1)
    }
  })

  it("asks the host for its agent list once for a burst of parallel delegations", async () => {
    const h = await harness({ sessions: { root: { id: "root" } }, seats: CONTROLLED, agents: [...STOCK_AGENTS, MALIK] })
    const calls = [1, 2, 3, 4].map((n) => taskCall("root", `call_${n}`, `Task ${n}`, `prompt ${n}`))
    await Promise.all(calls.map((call) => h.hooks["tool.execute.before"](call.input, call.output)))

    // A model fanning out eight subagents must not cost eight lookups.
    expect(h.agentListCalls()).toBe(1)
    for (const call of calls) expect(call.output.args["subagent_type"]).toBe(MALIK)
  })

  it("does not cache a failed lookup as an empty agent list", async () => {
    // One unlucky request must not turn into a session-long refusal to apply
    // any seat, so a failure is retried rather than remembered.
    const h = await harness({ sessions: { root: { id: "root" } }, seats: CONTROLLED, agentsUnavailable: true })
    const first = taskCall("root", "call_1", "One", "prompt one")
    const second = taskCall("root", "call_2", "Two", "prompt two")
    await h.hooks["tool.execute.before"](first.input, first.output)
    await h.hooks["tool.execute.before"](second.input, second.output)
    expect(h.agentListCalls()).toBe(2)
  })

  it("never asks the host anything at all while seat control is off", async () => {
    const h = await harness({ sessions: { root: { id: "root" } }, agents: [...STOCK_AGENTS, MALIK] })
    const call = taskCall("root", "call_1", "Audit the build", "prompt text")
    await h.hooks["tool.execute.before"](call.input, call.output)
    expect(h.agentListCalls()).toBe(0)
  })

  it("rewrites a camelCase subagentType in place rather than adding a second key", async () => {
    const h = await harness({ sessions: { root: { id: "root" } }, seats: CONTROLLED, agents: [...STOCK_AGENTS, MALIK] })
    const call = {
      input: { tool: "task", sessionID: "root", callID: "call_1" },
      output: { args: { description: "Audit the build", prompt: "prompt text", subagentType: "general" } as Record<string, any> },
    }
    await h.hooks["tool.execute.before"](call.input, call.output)
    expect(call.output.args["subagentType"]).toBe(MALIK)
    // Introducing a key the host does not read is at best noise.
    expect("subagent_type" in call.output.args).toBe(false)
  })
})

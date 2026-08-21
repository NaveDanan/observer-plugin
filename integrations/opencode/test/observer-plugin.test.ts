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

async function harness(
  options: {
    sessions?: Record<string, SessionRecord>
    /** Sessions whose lookup fails, standing in for an unreachable host. */
    unreachable?: string[]
    seat?: { id: string; directive: string; score: number }
    guidance?: boolean
  } = {},
): Promise<Harness> {
  const sessions = options.sessions ?? {}
  const unreachable = new Set(options.unreachable ?? [])
  const seat = options.seat ?? { id: "malik-johnson", directive: "Be calm and direct.", score: 9 }

  if (options.guidance === false) {
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 7788, token: "t0k3n", guidance: false }))
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

  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        if (unreachable.has(path.id)) throw new Error("host unreachable")
        const record = sessions[path.id]
        if (!record) throw new Error("no such session")
        return { data: record }
      },
    },
  }

  const hooks = await ObserverPlugin({ client, directory: "/repo", worktree: "/repo" })
  return {
    hooks,
    deliveries,
    of: (event: string) => deliveries.filter((delivery) => delivery.event === event),
    flush: async () => {
      await hooks.dispose()
    },
  }
}

const taskCall = (sessionID: string, callID: string, description: string, prompt: string, subagentType = "general") => ({
  input: { tool: "task", sessionID, callID },
  output: { args: { description, prompt, subagentType } },
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

const sessionCreated = (info: SessionRecord) => ({ type: "session.created", properties: { info } })

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
})

/**
 * The `/v1/hosts` contract, from the browser's side of the wire.
 *
 * This file replaces a set of drift tests. Until the endpoints landed, the
 * browser kept a mirror of the daemon's adapter tables — a static copy of
 * Claude's model gates, Codex's option ids, everyone's capabilities — because
 * nothing served them over HTTP. Those tests imported the real adapters and
 * failed if the copy drifted. The mirror is gone, so that purpose is gone with
 * it, and what matters now is the opposite question: **does the UI read the
 * server's answer faithfully, including the answers that are bad news?**
 *
 * So every fixture below is a verbatim body from Elias's own daemon tests in
 * `apps/daemon/test/hosts-api.test.ts`, and the cases are the ones a settings
 * page gets wrong: a null `capabilities`, a host with no profiles, an empty
 * model list that is a *success*, and a 404.
 *
 * `fetch` is stubbed rather than a server being started. The daemon's tests
 * already prove the server produces these bodies; these prove the browser does
 * the right thing when it receives them, and the seam between the two is the
 * JSON, which is exactly what is written out here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as api from "../src/api"
import type { HostCatalogue, HostSummary, ModelOptionDescriptor } from "../src/api"
import {
  catalogueNote,
  catalogueProfileNote,
  descriptorsFor,
  findHost,
  formatContext,
  freshnessLabel,
  hostLabel,
  hostOfTargetId,
  modelOptions,
  optionChoices,
  profileForTarget,
  profileOfTargetId,
  targetTitle,
} from "../src/settings/employees/directory"
import {
  hostCatalogueSnapshot,
  hostDirectorySnapshot,
  loadHostCatalogue,
  loadHostDirectory,
  resetHostCaches,
} from "../src/settings/employees/hosts"
import type { CatalogueState, HostDirectory } from "../src/settings/employees/hosts"
import { controlVerdict } from "../src/settings/employees/status"

/* ------------------------------------------------------- wire fixtures */

/** `GET /v1/hosts`, exactly as the daemon test asserts it. */
const OPENCODE_HOST: HostSummary = {
  id: "opencode",
  label: "OpenCode",
  profiles: [
    {
      id: "opencode:default",
      host: "opencode",
      label: "OpenCode",
      binaryPath: "/usr/bin/opencode",
      homePath: "/home/u/.opencode",
    },
  ],
  capabilities: { discovery: "cached", childModel: "supported", childReasoning: "supported", requiresReload: true },
  warnings: [],
}

const CODEX_HOST: HostSummary = {
  id: "codex",
  label: "Codex",
  profiles: [{ id: "codex:default", host: "codex", label: "Codex" }],
  capabilities: {
    discovery: "live",
    childModel: "experimental",
    childReasoning: "experimental",
    requiresReload: false,
  },
  warnings: [],
}

const CLAUDE_HOST: HostSummary = {
  id: "claude",
  label: "Claude Code",
  profiles: [{ id: "claude:default", host: "claude", label: "Claude Code" }],
  capabilities: { discovery: "cached", childModel: "unsupported", childReasoning: "unsupported", requiresReload: true },
  warnings: [],
}

/**
 * The contained-failure shape: no profiles, `capabilities: null`, two warnings.
 *
 * The daemon returns null rather than a conservative all-`unsupported` block,
 * on purpose. This fixture is the reason half the assertions in this file
 * exist.
 */
const BROKEN_HOST: HostSummary = {
  id: "claude",
  label: "Claude Code",
  profiles: [],
  capabilities: null,
  warnings: [
    "Observer could not list this host's profiles, so none are shown.",
    "Observer could not read what this host supports, so no control status is claimed for it.",
  ],
}

/** `GET /v1/hosts/:host/models`, the healthy shape with both descriptor types. */
const CATALOGUE: HostCatalogue = {
  host: "opencode",
  label: "OpenCode",
  profile: "opencode:default",
  models: [
    {
      id: "acme/big",
      label: "Acme Big",
      contextWindow: 200_000,
      options: [
        {
          id: "variant",
          label: "Reasoning effort",
          type: "select",
          choices: [
            { id: "low", label: "low" },
            { id: "high", label: "high", isDefault: true },
          ],
          currentValue: "high",
        },
        { id: "thinking", label: "Extended thinking", type: "boolean" },
      ],
    },
  ],
  source: "fake catalogue for opencode:default",
  freshness: "cached",
  warnings: [],
}

/** A host whose CLI is simply not installed. A 200, not an error. */
const MISSING_BINARY: HostCatalogue = {
  host: "codex",
  label: "Codex",
  profile: "codex:default",
  models: [],
  source: "codex app-server model/list",
  freshness: "unknown",
  warnings: ["Observer could not start codex. It may not be installed on this machine."],
}

function ready(catalogue: HostCatalogue): CatalogueState {
  return { status: "ready", catalogue }
}

function directoryOf(...hosts: HostSummary[]): HostDirectory {
  return { hosts, loading: false, error: undefined, settled: true }
}

/* ------------------------------------------------------------ fetch stub */

interface StubbedCall {
  url: string
}

let calls: StubbedCall[] = []
let respond: (url: string) => { status: number; body: unknown }

beforeEach(() => {
  calls = []
  respond = () => ({ status: 200, body: { hosts: [] } })
  resetHostCaches()
  api.setToken("test-token")
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url })
    void init
    const answer = respond(url)
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
    } as Response
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetHostCaches()
})

/* ------------------------------------------------------------------ tests */

describe("GET /v1/hosts", () => {
  it("reads label, profiles and capabilities per host, in the order sent", async () => {
    respond = () => ({ status: 200, body: { hosts: [OPENCODE_HOST, CODEX_HOST, CLAUDE_HOST] } })
    await loadHostDirectory()

    const directory = hostDirectorySnapshot()
    expect(calls.map((call) => call.url)).toEqual(["/v1/hosts"])
    expect(directory.hosts.map((host) => host.id)).toEqual(["opencode", "codex", "claude"])
    expect(directory.settled).toBe(true)
    expect(directory.error).toBeUndefined()
    expect(findHost(directory, "opencode")?.profiles[0]?.binaryPath).toBe("/usr/bin/opencode")
    expect(hostLabel(directory, "claude")).toBe("Claude Code")
  })

  it("is fetched once, not once per component that asks", async () => {
    respond = () => ({ status: 200, body: { hosts: [OPENCODE_HOST] } })
    await Promise.all([loadHostDirectory(), loadHostDirectory(), loadHostDirectory()])
    await loadHostDirectory()
    expect(calls).toHaveLength(1)
  })

  it("keeps the list it already had when a forced reload fails", async () => {
    respond = () => ({ status: 200, body: { hosts: [OPENCODE_HOST] } })
    await loadHostDirectory()
    respond = () => ({ status: 500, body: { error: "boom" } })
    await loadHostDirectory(true)

    const directory = hostDirectorySnapshot()
    // A failed refresh must not blank a directory that was answering a moment
    // ago: the user would watch every target lose its status for no reason.
    expect(directory.hosts.map((host) => host.id)).toEqual(["opencode"])
    expect(directory.error).toContain("500")
  })

  it("falls back to raw ids when the host list never arrives", async () => {
    respond = () => ({ status: 503, body: { error: "down" } })
    await loadHostDirectory()
    const directory = hostDirectorySnapshot()
    expect(directory.hosts).toEqual([])
    expect(hostLabel(directory, "opencode")).toBe("opencode")
    expect(targetTitle(directory, "opencode:default", "opencode")).toBe("opencode / default")
  })
})

describe("a null capabilities is unknown, never 'no control'", () => {
  it("says so, and does not claim the host cannot steer a child", () => {
    const verdict = controlVerdict(directoryOf(BROKEN_HOST), "claude", true)

    expect(verdict.status).toBe("unknown")
    expect(verdict.label).toBe("control unknown")
    // The distinction the endpoint's null exists to preserve.
    expect(verdict.sentence).toContain("nobody checked")
    expect(verdict.label).not.toBe("not applied to children")
    expect(verdict.sentence).not.toMatch(/exposes no way/)
  })

  it("claims no restart requirement either, because nobody said there was one", () => {
    const verdict = controlVerdict(directoryOf(BROKEN_HOST), "claude", true)
    expect(verdict.requiresReload).toBe(false)
    expect(verdict.reloadSentence).toBeUndefined()
  })

  it("carries the daemon's own warnings through for rendering", () => {
    const verdict = controlVerdict(directoryOf(BROKEN_HOST), "claude", true)
    expect(verdict.warnings).toEqual(BROKEN_HOST.warnings)
  })

  it("stays unknown whether or not seat control is on", () => {
    for (const control of [true, false]) {
      expect(controlVerdict(directoryOf(BROKEN_HOST), "claude", control).status, String(control)).toBe("unknown")
    }
  })

  it("is a different verdict from an adapter that looked and said unsupported", () => {
    expect(controlVerdict(directoryOf(CLAUDE_HOST), "claude", true).status).toBe("inert")
    expect(controlVerdict(directoryOf(CLAUDE_HOST), "claude", true).label).toBe("not applied to children")
  })
})

describe("a host with no profiles", () => {
  it("still renders, and asks the endpoint for no particular profile", () => {
    expect(BROKEN_HOST.profiles).toEqual([])
    // Nothing to match, so no `?profile=` is sent and the server picks. Sending
    // the target key regardless would ask for a profile the host just said it
    // does not have.
    expect(profileForTarget(BROKEN_HOST, "claude:default")).toBeUndefined()
  })

  it("offers no rows in the add-a-target menu, because there is nothing to add", () => {
    const directory = directoryOf(BROKEN_HOST, OPENCODE_HOST)
    const addable = directory.hosts.flatMap((entry) => entry.profiles.map((profile) => profile.id))
    expect(addable).toEqual(["opencode:default"])
  })

  it("sends ?profile only for a target the host actually reports", () => {
    expect(profileForTarget(CODEX_HOST, "codex:default")).toBe("codex:default")
    expect(profileForTarget(CODEX_HOST, "codex:work")).toBeUndefined()
  })
})

describe("GET /v1/hosts/:host/models", () => {
  it("reads models and both descriptor types straight off the wire", async () => {
    respond = () => ({ status: 200, body: CATALOGUE })
    await loadHostCatalogue("opencode", "opencode:default")

    const state = hostCatalogueSnapshot("opencode", "opencode:default")
    expect(calls[0]?.url).toBe("/v1/hosts/opencode/models?profile=opencode%3Adefault")
    expect(state.status).toBe("ready")
    const descriptors = descriptorsFor(state, "OpenCode", "acme/big").descriptors
    expect(descriptors.map((option) => ({ id: option.id, type: option.type }))).toEqual([
      { id: "variant", type: "select" },
      { id: "thinking", type: "boolean" },
    ])
  })

  it("omits ?profile entirely when there is none to send", async () => {
    respond = () => ({ status: 200, body: CATALOGUE })
    await loadHostCatalogue("codex", undefined)
    expect(calls[0]?.url).toBe("/v1/hosts/codex/models")
  })

  it("caches per host and profile, so two accounts do not share a list", async () => {
    respond = (url) => ({
      status: 200,
      body: { ...CATALOGUE, host: "codex", label: "Codex", profile: url.includes("work") ? "codex:work" : "codex:personal" },
    })
    await loadHostCatalogue("codex", "codex:work")
    await loadHostCatalogue("codex", "codex:personal")
    await loadHostCatalogue("codex", "codex:work")

    expect(calls).toHaveLength(2)
    const work = hostCatalogueSnapshot("codex", "codex:work")
    expect(work.status === "ready" && work.catalogue.profile).toBe("codex:work")
  })

  it("does not fetch anything until it is asked", () => {
    // The laziness guarantee, stated as the absence it is. `/v1/hosts` is
    // spawn-free and eager; this one can start a process and is not.
    expect(calls).toHaveLength(0)
    expect(hostCatalogueSnapshot("codex", "codex:default")).toEqual({ status: "idle" })
  })

  it("refetches only when explicitly refreshed", async () => {
    respond = () => ({ status: 200, body: CATALOGUE })
    await loadHostCatalogue("opencode", "opencode:default")
    await loadHostCatalogue("opencode", "opencode:default")
    expect(calls).toHaveLength(1)
    await loadHostCatalogue("opencode", "opencode:default", true)
    expect(calls).toHaveLength(2)
  })
})

describe("an empty model list with a warning is a success, not a failure", () => {
  it("stays ready, and shows the daemon's sentence rather than an error", async () => {
    respond = () => ({ status: 200, body: MISSING_BINARY })
    await loadHostCatalogue("codex", "codex:default")

    const state = hostCatalogueSnapshot("codex", "codex:default")
    expect(state.status).toBe("ready")
    expect(state.status === "ready" && state.catalogue.models).toEqual([])
    expect(state.status === "ready" && state.catalogue.freshness).toBe("unknown")
    expect(catalogueNote(MISSING_BINARY)).toBe(
      "Observer could not start codex. It may not be installed on this machine.",
    )
  })

  it("puts that sentence where the option controls would have been", () => {
    const answer = descriptorsFor(ready(MISSING_BINARY), "Codex", "gpt-5.6-sol")
    expect(answer.descriptors).toEqual([])
    expect(answer.note).toContain("may not be installed")
  })

  it("still offers the model the config already names, so it can be edited", () => {
    const options = modelOptions(ready(MISSING_BINARY), "gpt-5.6-sol", "")
    expect(options.map((option) => option.value)).toEqual(["", "gpt-5.6-sol"])
  })
})

describe("a 404 is the browser's problem to explain", () => {
  it("becomes an error state, not an empty catalogue", async () => {
    respond = () => ({ status: 404, body: { error: "unknown host" } })
    await loadHostCatalogue("cursor", undefined)

    const state = hostCatalogueSnapshot("cursor", undefined)
    expect(state.status).toBe("error")
    expect(state.status === "error" && state.error).toContain("404")
  })

  it("says the list could not be read rather than that the model has no options", () => {
    const answer = descriptorsFor({ status: "error", error: "GET /v1/hosts/cursor/models failed: 404" }, "cursor", "x")
    expect(answer.descriptors).toEqual([])
    expect(answer.note).toContain("could not read")
    expect(answer.note).not.toMatch(/describes no options/)
  })

  it("leaves the free-text picker usable, so the target is still editable", () => {
    const options = modelOptions({ status: "error", error: "boom" }, "composer-2", "")
    expect(options.map((option) => option.value)).toEqual(["", "composer-2"])
  })
})

describe("loading is a state, not a blank", () => {
  it("says the list is being read rather than showing no options", () => {
    for (const state of [{ status: "idle" } as const, { status: "loading" } as const]) {
      const answer = descriptorsFor(state, "Codex", "gpt-5.6-sol")
      expect(answer.descriptors, state.status).toEqual([])
      expect(answer.note, state.status).toBe("Reading Codex's model list…")
    }
  })

  it("says nothing at all about a target while the host list is in flight", () => {
    const verdict = controlVerdict({ hosts: [], loading: true, error: undefined, settled: false }, "opencode", true)
    expect(verdict.status).toBe("unknown")
    expect(verdict.label).toBe("checking…")
  })

  it("blames its own host list, not the host, when that request failed", () => {
    const verdict = controlVerdict({ hosts: [], loading: false, error: "boom", settled: true }, "opencode", true)
    expect(verdict.status).toBe("unknown")
    expect(verdict.sentence).toContain("could not read its host list")
  })
})

describe("control status never overstates", () => {
  const directory = directoryOf(OPENCODE_HOST, CODEX_HOST, CLAUDE_HOST)

  it("is applied only for OpenCode, and only with seat control on", () => {
    expect(controlVerdict(directory, "opencode", true).status).toBe("applied")
    expect(controlVerdict(directory, "opencode", false).status).toBe("configured")
    expect(controlVerdict(directory, "opencode", false).sentence).toMatch(/seat control is off/)
  })

  it("says OpenCode needs a restart, because it reads agent definitions once", () => {
    expect(controlVerdict(directory, "opencode", true).requiresReload).toBe(true)
    expect(controlVerdict(directory, "opencode", true).reloadSentence).toMatch(/next time you start/)
  })

  it("calls Codex experimental whether or not seat control is on", () => {
    expect(controlVerdict(directory, "codex", true).status).toBe("experimental")
    expect(controlVerdict(directory, "codex", false).status).toBe("experimental")
    expect(controlVerdict(directory, "codex", true).sentence).toMatch(/fails open/)
    expect(controlVerdict(directory, "codex", true).requiresReload).toBe(false)
  })

  it("never lets a host the daemon does not list look like it steers a child", () => {
    // Cursor and Grok are absent from `/v1/hosts` because no adapter claims
    // them. A target for either still renders, and says exactly that.
    for (const host of ["cursor", "grok", "cursur"]) {
      for (const control of [true, false]) {
        const verdict = controlVerdict(directory, host, control)
        expect(verdict.status, `${host}/${control}`).toBe("inert")
        expect(verdict.label).toBe("no adapter")
        expect(verdict.sentence).toContain("No adapter in this build")
      }
    }
  })

  it("does not send the user to flip seat control for a host it would not help", () => {
    for (const host of ["claude", "cursor"]) {
      expect(controlVerdict(directory, host, false).sentence, host).not.toMatch(/Turn seat control on/)
    }
  })
})

describe("the server's freshness vocabulary is the only one on screen", () => {
  it("maps all three values, and invents no fourth", () => {
    expect(freshnessLabel("live")).toBe("read live")
    expect(freshnessLabel("cached")).toBe("from a cache")
    expect(freshnessLabel("unknown")).toBe("source unknown")
  })

  it("names the source and the count when a list did arrive", () => {
    expect(catalogueNote(CATALOGUE)).toBe("1 model, from a cache from fake catalogue for opencode:default.")
  })

  it("prefers the daemon's warnings over anything it could say itself", () => {
    expect(catalogueNote({ ...CATALOGUE, warnings: ["a warning"] })).toBe("a warning")
  })
})

describe("the echoed profile is checked, not assumed", () => {
  it("is silent when the server answered for the profile that was asked about", () => {
    expect(catalogueProfileNote(CATALOGUE, "opencode:default")).toBeUndefined()
  })

  it("warns when the server answered for a different profile", () => {
    const note = catalogueProfileNote({ ...CATALOGUE, profile: "codex:work" }, "codex:personal")
    expect(note).toContain('filed under "codex:personal"')
    expect(note).toContain('answered for "codex:work"')
  })

  it("warns when the server could name no profile at all", () => {
    // The contained-failure shape: `profile: ""`.
    expect(catalogueProfileNote({ ...CATALOGUE, profile: "" }, "claude:default")).toContain("could not name a profile")
  })
})

describe("descriptors are the only licence to draw a control", () => {
  it("asks for a model before it describes any option", () => {
    const answer = descriptorsFor(ready(CATALOGUE), "OpenCode", undefined)
    expect(answer.descriptors).toEqual([])
    expect(answer.note).toMatch(/Choose a model first/)
  })

  it("treats an empty options array as the host's answer, not as a missing feature", () => {
    const bare = { ...CATALOGUE, models: [{ id: "acme/bare", label: "Acme Bare", options: [] }] }
    const answer = descriptorsFor(ready(bare), "OpenCode", "acme/bare")
    expect(answer.descriptors).toEqual([])
    expect(answer.note).toContain("describes no options")
  })

  it("admits a gap in what it read rather than inventing options for an unlisted model", () => {
    const answer = descriptorsFor(ready(CATALOGUE), "OpenCode", "acme/never-heard-of-it")
    expect(answer.descriptors).toEqual([])
    expect(answer.note).toMatch(/gap in what Observer read/)
  })

  it("passes a select's choices and its host default through untouched", () => {
    const [variant] = descriptorsFor(ready(CATALOGUE), "OpenCode", "acme/big").descriptors as ModelOptionDescriptor[]
    expect(variant?.choices).toEqual([
      { id: "low", label: "low" },
      { id: "high", label: "high", isDefault: true },
    ])
    expect(optionChoices(variant as ModelOptionDescriptor, undefined).map((option) => option.label)).toEqual([
      "Unset",
      "low",
      "high · host default",
    ])
  })

  it("pins a stored value the descriptor no longer offers, so it can be cleared", () => {
    const [variant] = descriptorsFor(ready(CATALOGUE), "OpenCode", "acme/big").descriptors as ModelOptionDescriptor[]
    expect(optionChoices(variant as ModelOptionDescriptor, "xhigh").map((option) => option.value)).toEqual([
      "",
      "low",
      "high",
      "xhigh",
    ])
  })
})

describe("target ids", () => {
  it("splits on the first colon only, because a profile may contain another", () => {
    expect(hostOfTargetId("codex:work:eu")).toBe("codex")
    expect(profileOfTargetId("codex:work:eu")).toBe("work:eu")
    expect(hostOfTargetId("opencode")).toBe("opencode")
    expect(profileOfTargetId("opencode")).toBe("default")
  })

  it("titles a target with the server's label and the profile half", () => {
    expect(targetTitle(directoryOf(CLAUDE_HOST), "claude:default", "claude")).toBe("Claude Code / default")
  })
})

describe("context windows", () => {
  it("formats the way the daemon's own column does", () => {
    expect(formatContext(200_000)).toBe("200K")
    expect(formatContext(1_000_000)).toBe("1M")
    expect(formatContext(512)).toBe("512")
    expect(formatContext(0)).toBeUndefined()
    expect(formatContext(undefined)).toBeUndefined()
  })
})

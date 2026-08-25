import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CODEX_DEFAULT_PROFILE,
  createCodexAdapter,
  spawnCodexAppServer,
} from "../../../apps/daemon/src/adapters/codex.js"
import type { TargetProfile } from "../src/config-ui-state.js"
import { loadTargetCatalogue } from "../src/config-ui-catalogues.js"

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("Codex catalogue loading", () => {
  it("keeps the app-server connection open and gives the TUI models with their reasoning efforts", () => {
    const directory = mkdtempSync(join(tmpdir(), "observer-codex-catalogue-"))
    temporaryDirectories.push(directory)
    const fixture = join(directory, "codex-app-server.mjs")
    writeFileSync(
      fixture,
      String.raw`
let disconnected = false
let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("end", () => { disconnected = true })
process.stdin.on("data", (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf("\n")
    if (newline < 0) break
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    let request
    try { request = JSON.parse(line) } catch { continue }
    if (request?.id !== 2 || request?.method !== "model/list") continue
    setTimeout(() => {
      if (disconnected) return
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          data: [{
            id: "gpt-fixture",
            displayName: "GPT Fixture",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "xhigh", description: "Deep" },
            ],
            defaultReasoningEffort: "xhigh",
          }],
          nextCursor: null,
        },
      }) + "\n")
    }, 25)
  }
})
`,
      "utf8",
    )

    const codex = createCodexAdapter({
      binaryPath: process.execPath,
      env: {},
      homeDir: () => "/home/tester",
      spawn: (_binary, _args, options) => spawnCodexAppServer(process.execPath, [fixture], options),
    })
    const profiles: TargetProfile[] = codex.profiles().map((profile) => ({
      id: profile.id,
      host: codex.kind,
      hostLabel: codex.label,
      profileLabel: profile.label,
      capabilities: codex.capabilities(profile.id),
    }))

    const catalogue = loadTargetCatalogue([codex], profiles, CODEX_DEFAULT_PROFILE)

    expect(catalogue.models.map((model) => model.id)).toEqual(["gpt-fixture"])
    expect(catalogue.models[0]?.options).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning effort",
        type: "select",
        currentValue: "xhigh",
        choices: [
          { id: "low", label: "low" },
          { id: "xhigh", label: "xhigh", isDefault: true },
        ],
      },
    ])
  })
})

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const read = path => JSON.parse(readFileSync(path, "utf8"))
for (const host of ["codex", "copilot"]) {
  test(`${host}: cached plugin works in a spaced path and fails open before setup`, () => {
    const sandbox = mkdtempSync(join(tmpdir(), "observer marketplace "))
    const plugin = join(sandbox, "plugin with spaces")
    cpSync(join(root, host === "codex" ? "plugins/observer" : "plugins/copilot/observer"), plugin, { recursive: true })
    const env = { ...process.env, OBSERVER_HOME: join(sandbox, "data"), PLUGIN_ROOT: plugin, COPILOT_PLUGIN_ROOT: plugin }
    const invoke = entry => spawnSync(process.execPath, [join(plugin, "scripts", `${entry}.mjs`), "--host", host, "--event", "sample"], { env, encoding: "utf8" })
    assert.equal(invoke("emit").status, 0)
    assert.equal(invoke("emit").stdout, "")
    assert.equal(invoke(`${host}-control`).status, 0)
    assert.notEqual(invoke("coordination-mcp").status, 0)
    const runtime = join(env.OBSERVER_HOME, "runtimes", read(join(plugin, "runtime.json")).version, "node_modules/observer-ai/dist")
    mkdirSync(runtime, { recursive: true })
    writeFileSync(join(runtime, "emit.js"), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    assert.deepEqual(JSON.parse(invoke("emit").stdout), ["--host", host, "--event", "sample"])
    const hooks = read(join(plugin, "hooks/hooks.json")).hooks
    for (const [event, groups] of Object.entries(hooks)) {
      const handlers = host === "codex" ? groups.flatMap(group => group.hooks) : groups
      const handler = handlers.at(-1)
      if (process.platform === "win32") {
        const shell = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", host === "codex" ? handler.commandWindows : handler.powershell], { env, encoding: "utf8" })
        assert.equal(shell.status, 0, shell.stderr)
        assert.deepEqual(JSON.parse(shell.stdout), ["--host", host, "--event", event])
      }
    }
    assert.ok(read(join(plugin, ".mcp.json")).mcpServers.observer.args[0].startsWith("${PLUGIN_ROOT}/"))
  })
}

test("catalog paths resolve to matching plugin names and versions", () => {
  const codex = read(join(root, ".agents/plugins/marketplace.json"))
  const copilot = read(join(root, ".github/plugin/marketplace.json"))
  assert.equal(codex.name, copilot.name)
  for (const [catalog, manifest] of [[codex, ".codex-plugin/plugin.json"], [copilot, "plugin.json"]]) {
    const entry = catalog.plugins[0]
    const plugin = read(join(root, typeof entry.source === "string" ? entry.source : entry.source.path, manifest))
    assert.equal(entry.name, plugin.name)
    assert.equal(plugin.version, "0.9.21")
  }
})

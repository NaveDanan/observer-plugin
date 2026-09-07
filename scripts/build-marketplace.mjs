import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { activeEmployees, behaviorDirective, employeeDescription, rosterBriefing } from "../packages/roster/dist/index.js"
import { HOST_EVENTS } from "../packages/cli/dist/install.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const version = "0.9.21"
const repository = "https://github.com/NaveDanan/observer-plugin"
const release = { version, url: `${repository}/releases/download/v${version}/observer-ai-${version}.tgz`, sha256: "d561d53627fabecea8d31488ba41ef1fa824ae2ad96ea94e908f6f4fea1cce13" }
const json = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n") }
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
const windows = (file, host, event) => {
  const payload = `& node (Join-Path $env:PLUGIN_ROOT 'scripts/${file}.mjs') --host '${host}' --event '${event}'`
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(payload, "utf16le").toString("base64")}`
}

for (const host of ["codex", "copilot"]) {
  const directory = join(root, host === "codex" ? "plugins/observer" : "plugins/copilot/observer")
  const metadata = { name: "observer", version, description: "Watch coding agents on a local canvas and coordinate work with six employee specialties.", author: { name: "NaveDanan", url: "https://github.com/NaveDanan" }, homepage: repository, repository, license: "MIT", keywords: ["agents", "observability", "delegation", "canvas"], skills: "./skills/", mcpServers: "./.mcp.json" }
  if (host === "codex") {
    json(join(directory, ".codex-plugin/plugin.json"), { ...metadata, interface: { displayName: "Observer", shortDescription: "Watch and coordinate coding agents locally.", longDescription: `${metadata.description} Requires Node.js 22.5+ and one-time runtime setup. Session data stays on your computer.`, developerName: "NaveDanan", category: "Developer Tools", capabilities: ["Observability"], websiteURL: repository, defaultPrompt: ["Set up Observer for this computer.", "Use Observer to coordinate this task."] } })
  } else {
    json(join(directory, "plugin.json"), { ...metadata, agents: "./agents/", hooks: "./hooks/hooks.json" })
  }
  json(join(directory, "runtime.json"), release)
  cpSync(join(root, "scripts/plugin-runtime"), join(directory, "scripts"), { recursive: true })
  for (const entry of ["emit", `${host}-control`, "coordination-mcp", "cli"]) {
    write(join(directory, "scripts", `${entry}.mjs`), `import { run } from "./runtime.mjs"\nawait run(${JSON.stringify(entry)})\n`)
  }
  json(join(directory, ".mcp.json"), { mcpServers: { observer: { command: "node", args: ["${PLUGIN_ROOT}/scripts/coordination-mcp.mjs", "--host", host] } } })
  const hooks = {}
  for (const event of HOST_EVENTS[host]) {
    const entries = event.toLowerCase() === "pretooluse" ? [`${host}-control`, "emit"] : ["emit"]
    const handlers = entries.map(entry => host === "codex" ? {
      type: "command", command: `node "$PLUGIN_ROOT/scripts/${entry}.mjs" --host ${host} --event ${event}`, commandWindows: windows(entry, host, event), timeout: 5,
    } : {
      type: "command", bash: `node "\${COPILOT_PLUGIN_ROOT}/scripts/${entry}.mjs" --host ${host} --event ${event}`, powershell: `& node "$env:COPILOT_PLUGIN_ROOT/scripts/${entry}.mjs" --host ${host} --event ${event}`, timeoutSec: 5,
    })
    hooks[event] = host === "codex" ? [{ hooks: handlers }] : handlers
  }
  json(join(directory, "hooks/hooks.json"), host === "codex" ? { hooks } : { version: 1, hooks })
  for (const employee of activeEmployees()) {
    const name = `observer-${employee.id}`
    const instructions = behaviorDirective(employee)
    if (host === "copilot") write(join(directory, "agents", `${name}.agent.md`), `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(employeeDescription(employee))}\n---\n\n${instructions}\n`)
    else write(join(directory, "codex-agents", `${name}.toml`), `# observer:employee-agent v1\nname = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(employeeDescription(employee))}\ndeveloper_instructions = ${JSON.stringify(instructions)}\n`)
  }
  write(join(directory, "skills/observer/SKILL.md"), `---\nname: observer\ndescription: Use when the user asks to set up Observer, inspect its local agent canvas, or explicitly invokes Observer to coordinate delegated work.\n---\n\n# Observer\n\n## Setup and status\n\nResolve this plugin's root two directories above this SKILL.md. When the user requests setup, run \`node "<plugin-root>/scripts/setup.mjs"\`. This downloads the pinned Observer release, verifies its SHA-256, installs it under ~/.observer/runtimes/${version}, and starts the local daemon. Requires Node.js 22.5+ and npm. Setup adds missing Codex employee definitions when applicable; existing definitions are preserved. Restart the host after setup to load agents and MCP tools. In Codex, approve the Observer hooks using /hooks.\n\nFor status run \`node "<plugin-root>/scripts/cli.mjs" status\`; to open the canvas run \`node "<plugin-root>/scripts/cli.mjs" open\`. Do not run observer install for the same host: this marketplace already supplies its hooks. If another Observer installation already supplies hooks, use only one plugin or hook installation to avoid duplicate events.\n\n## Delegation\n\nUse this section only when the user explicitly asks Observer to coordinate work.\n\n${rosterBriefing(activeEmployees())}\n\nSelect employee agents from the host's actual available agent list. If one is unavailable, use employee_brief when available and pass the relevant contract in the delegated prompt. Explain any default-agent fallback. Discover current tools and skills before using them. Complete the root task after collecting results.\n`)
  write(join(directory, "README.md"), `# Observer for ${host === "codex" ? "Codex" : "GitHub Copilot"}\n\n${metadata.description}\n\nRequires Node.js 22.5+ with npm. After installing the plugin, ask **Set up Observer for this computer**. Setup downloads the checksum-pinned [v${version} runtime](${release.url}), installs it in ~/.observer/runtimes/${version}, and starts the local daemon. Restart the host after setup; Codex also requires trusting hooks with /hooks.\n\nThe plugin records local session events, prompts, tool calls, replies, and agent relationships in ~/.observer. The daemon binds to 127.0.0.1. Setup contacts GitHub and npm; agent data is not sent to an Observer cloud service. Existing host/model services retain their own data policies.\n\nUse only one Observer hook/plugin installation per host. The dashboard switch disables this plugin's hooks and tools; it does not erase data or stop the shared daemon. Run scripts/cli.mjs stop to stop the daemon.\n\n[Source and support](${repository}) · [License](${repository}/blob/master/LICENSE)\n`)
  cpSync(join(root, "LICENSE"), join(directory, "LICENSE"))
}
json(join(root, ".github/plugin/marketplace.json"), { name: "observer-public", owner: { name: "NaveDanan" }, metadata: { description: "Observer coding-agent canvas and employee coordination", version }, plugins: [{ name: "observer", description: "Watch and coordinate coding agents on a local canvas. Requires Node.js and one-time runtime setup.", version, source: "./plugins/copilot/observer" }] })
console.log("Built Codex and Copilot marketplace plugins for Observer " + version)

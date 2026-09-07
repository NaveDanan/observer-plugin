import { createHash } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, copyFileSync, constants } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { pluginRoot, release, runtimePrefix, runtimeRoot } from "./runtime.mjs"

const [major, minor] = process.versions.node.split(".").map(Number)
if (major < 22 || (major === 22 && minor < 5)) throw new Error("Observer requires Node.js 22.5 or newer.")
const manifest = join(runtimeRoot, "package.json")
if (!existsSync(manifest)) {
  const response = await fetch(release.url)
  if (!response.ok) throw new Error(`Release download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (createHash("sha256").update(bytes).digest("hex") !== release.sha256) {
    throw new Error("Release checksum mismatch. No software was installed.")
  }
  const downloadDir = mkdtempSync(join(tmpdir(), "observer-release-"))
  const tarball = join(downloadDir, `observer-ai-${release.version}.tgz`)
  writeFileSync(tarball, bytes)
  const directories = [dirname(process.execPath), ...(process.env.PATH || "").split(delimiter)]
  const npmCli = directories.flatMap(directory => [
    join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ]).find(existsSync)
  if (!npmCli) throw new Error("npm was not found beside Node.js or on PATH. Install Node.js with npm and retry.")
  mkdirSync(runtimePrefix, { recursive: true })
  execFileSync(process.execPath, [npmCli, "install", "--prefix", runtimePrefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball], { stdio: "inherit", windowsHide: true })
}
if (JSON.parse(readFileSync(manifest, "utf8")).version !== release.version) throw new Error("Installed runtime version does not match the plugin.")
// Verify the installed dependency tree even when resuming a previous setup.
execFileSync(process.execPath, [join(runtimeRoot, "dist", "cli.js"), "version"], { stdio: "inherit", windowsHide: true })

if (existsSync(join(pluginRoot, "codex-agents"))) {
  const destination = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "agents")
  mkdirSync(destination, { recursive: true })
  for (const file of readdirSync(join(pluginRoot, "codex-agents"))) {
    const target = join(destination, file)
    if (existsSync(target)) continue
    copyFileSync(join(pluginRoot, "codex-agents", file), target, constants.COPYFILE_EXCL)
  }
}
const started = spawnSync(process.execPath, [join(runtimeRoot, "dist", "cli.js"), "start"], { encoding: "utf8", windowsHide: true })
if (started.status === 0) {
  process.stdout.write(started.stdout)
} else {
  // First startup can exceed the runtime CLI's short readiness window.
  const dataRoot = process.env.OBSERVER_HOME || join(homedir(), ".observer")
  const config = JSON.parse(readFileSync(join(dataRoot, "config.json"), "utf8").replace(/^\uFEFF/, ""))
  const deadline = Date.now() + 30000
  let ready = false
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/v1/diagnostics`, { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(1500) })
      if (response.ok) { ready = true; break }
    } catch { /* Allow the already-started daemon to finish loading. */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error(started.stderr || started.error?.message || "Observer daemon did not become ready.")
  console.log(`Observer is running on http://127.0.0.1:${config.port}`)
}

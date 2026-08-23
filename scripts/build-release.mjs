#!/usr/bin/env node
/**
 * Builds a self-contained, installable Observer package.
 *
 * The monorepo uses `workspace:*` dependencies, which cannot be resolved on
 * another machine. This script bundles all first-party code into three entry
 * points and emits a flat package whose only dependencies are real npm
 * packages, so the result installs with plain `npm i -g <tarball>`.
 *
 * Output layout:
 *   observer-ai-<version>.tgz
 *     dist/cli.js                          -> bin: observer
 *     dist/daemon.js                       -> bin: observer-daemon
 *     dist/emit.js                         -> bin: observer-emit
 *     dist/copilot-control.js              -> bin: observer-copilot-control
 *     web/                                 built UI, served by the daemon
 *     integrations/opencode/observer-plugin.js
 */
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const releaseDir = join(root, "release")
const stageDir = join(releaseDir, "package")

const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const version = process.env.OBSERVER_VERSION ?? rootManifest.version ?? "0.1.0"

/** Kept external so they install from npm rather than being inlined. */
const EXTERNAL = ["fastify", "@fastify/websocket"]

function log(message) {
  process.stdout.write(`${message}\n`)
}

function requireBuilt(path, hint) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Run \`pnpm build\` first.${hint ? ` (${hint})` : ""}`)
  }
}

const SHEBANG = "#!/usr/bin/env node"

async function bundle(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: false,
    sourcemap: false,
    external: EXTERNAL,
    define: { __OBSERVER_VERSION__: JSON.stringify(version) },
    logLevel: "warning",
  })

  // esbuild preserves the entry point's own shebang. Normalise rather than
  // adding a banner, which would emit a second, syntactically invalid one.
  const code = readFileSync(outfile, "utf8")
  const lines = code.split("\n")
  const body = lines[0]?.startsWith("#!") ? lines.slice(1).join("\n") : code
  if (body.includes(`\n${SHEBANG}`)) {
    throw new Error(`${outfile} contains a shebang outside line 1`)
  }
  writeFileSync(outfile, `${SHEBANG}\n${body}`)
  chmodSync(outfile, 0o755)

  const size = (statSync(outfile).size / 1024).toFixed(0)
  log(`  bundled ${outfile.replace(`${stageDir}/`, "")} (${size} kB)`)
}

function directorySize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    total += entry.isDirectory() ? directorySize(path) : statSync(path).size
  }
  return total
}

async function main() {
  log(`Building Observer ${version} release`)

  // The web UI is a normal Vite build; the bundler only handles server code.
  requireBuilt(join(root, "apps/web/dist/index.html"), "pnpm --filter @observer-ai/web build")

  rmSync(releaseDir, { recursive: true, force: true })
  mkdirSync(join(stageDir, "dist"), { recursive: true })

  log("Bundling entry points")
  await bundle(join(root, "packages/cli/src/cli.ts"), join(stageDir, "dist/cli.js"))
  await bundle(join(root, "apps/daemon/src/main.ts"), join(stageDir, "dist/daemon.js"))
  await bundle(join(root, "packages/hook-emitter/src/emit.ts"), join(stageDir, "dist/emit.js"))
  await bundle(
    join(root, "packages/hook-emitter/src/copilot-control.ts"),
    join(stageDir, "dist/copilot-control.js"),
  )

  log("Copying assets")
  cpSync(join(root, "apps/web/dist"), join(stageDir, "web"), { recursive: true })
  mkdirSync(join(stageDir, "integrations/opencode"), { recursive: true })
  cpSync(
    join(root, "integrations/opencode/observer-plugin.js"),
    join(stageDir, "integrations/opencode/observer-plugin.js"),
  )
  cpSync(
    join(root, "integrations/opencode/observer-agent.md"),
    join(stageDir, "integrations/opencode/observer-agent.md"),
  )
  for (const file of ["README.md", "LICENSE"]) {
    if (existsSync(join(root, file))) cpSync(join(root, file), join(stageDir, file))
  }
  cpSync(join(root, "docs"), join(stageDir, "docs"), { recursive: true })
  cpSync(join(root, "integrations/README.md"), join(stageDir, "docs/integrations.md"))

  // Resolve the real versions used in the workspace so the published package
  // pins what was actually tested.
  const daemonManifest = JSON.parse(readFileSync(join(root, "apps/daemon/package.json"), "utf8"))
  const dependencies = {}
  for (const name of EXTERNAL) {
    const range = daemonManifest.dependencies?.[name]
    if (!range) throw new Error(`Cannot determine version range for external dependency ${name}`)
    dependencies[name] = range
  }

  const manifest = {
    name: "observer-ai",
    version,
    description:
      "Interactive canvas for the coding agents you are already running: OpenCode, Codex, Claude Code and GitHub Copilot CLI.",
    license: "MIT",
    type: "module",
    engines: { node: ">=22.5.0" },
    bin: {
      observer: "dist/cli.js",
      "observer-daemon": "dist/daemon.js",
      "observer-emit": "dist/emit.js",
      "observer-copilot-control": "dist/copilot-control.js",
    },
    files: ["dist", "web", "integrations", "docs", "README.md", "LICENSE"],
    keywords: ["agents", "observability", "opencode", "codex", "claude-code", "copilot", "canvas"],
    dependencies,
  }
  writeFileSync(join(stageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)

  log("Packing")
  const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm"
  const npmArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm", "pack", "--pack-destination", releaseDir]
      : ["pack", "--pack-destination", releaseDir]
  const packed = execFileSync(npmCommand, npmArgs, {
    cwd: stageDir,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop()

  const tarball = join(releaseDir, packed)
  const tarballSize = (statSync(tarball).size / 1024 / 1024).toFixed(2)
  const stagedSize = (directorySize(stageDir) / 1024 / 1024).toFixed(2)

  log("")
  log(`Release ready: ${tarball}`)
  log(`  tarball ${tarballSize} MB, unpacked ${stagedSize} MB`)
  log("")
  log("Install on another machine:")
  log(`  npm install -g ${packed}`)
  log("  observer install all")
  log("  observer start && observer open")
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})

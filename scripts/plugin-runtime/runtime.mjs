import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
export const release = JSON.parse(readFileSync(join(pluginRoot, "runtime.json"), "utf8"))
export const runtimePrefix = join(process.env.OBSERVER_HOME || join(homedir(), ".observer"), "runtimes", release.version)
export const runtimeRoot = join(runtimePrefix, "node_modules", "observer-ai")

export async function run(entry, args = process.argv.slice(2)) {
  const script = join(runtimeRoot, "dist", `${entry}.js`)
  if (!existsSync(script)) {
    // Telemetry must never block the host or write hook decisions to stdout.
    if (entry === "emit" || entry.endsWith("-control")) return
    throw new Error(`Observer runtime is missing. Run: node "${join(pluginRoot, "scripts", "setup.mjs")}"`)
  }
  process.argv = [process.execPath, script, ...args]
  await import(pathToFileURL(script).href)
}

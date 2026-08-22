#!/usr/bin/env node
import { existsSync } from "node:fs"
import { HOSTS, HOST_CAPABILITIES, type HostId } from "@observer-ai/protocol"
import { configPath, databasePath, dataDir, logPath, spoolDir } from "@observer-ai/storage"
import { diagnoseSeats, loadConfig } from "@observer-ai/daemon"
import { HOST_EVENTS, hostConfigPath, install, isInstalled, uninstall } from "./install.js"
import {
  CODEX_PLUGIN_NAME,
  codexPluginDir,
  installCodexPlugin,
  isCodexPluginInstalled,
  personalMarketplacePath,
  uninstallCodexPlugin,
} from "./codex-plugin.js"
import { openBrowser, diagnostics, start, status, stop } from "./daemon-control.js"
import { runConfig } from "./config-ui.js"
import { canvasUrl, detectHarness, detectSession } from "./harness.js"
import { daemonPath, emitterPath, opencodePluginSource } from "./paths.js"

/** Replaced at bundle time by the release build; `typeof` keeps dev builds safe. */
declare const __OBSERVER_VERSION__: string
const VERSION = typeof __OBSERVER_VERSION__ === "string" ? __OBSERVER_VERSION__ : "dev"

const HELP = `Observer ${VERSION} - interactive canvas for running coding agents

Usage
  observer start [--port <n>]      Start the local daemon (background)
  observer stop                    Stop the daemon
  observer status                  Show daemon and integration status
  observer open [--host <harness>] Open the canvas, bound to the harness that
                                   opened it (auto-detected; --all to unbind)
  observer install <host...|all>   Install Observer into a host
  observer uninstall <host...|all> Remove Observer from a host
  observer config                  Turn seat control on or off and assign a
                                   model, reasoning effort and skills to each
                                   employee (interactive; prints the current
                                   seats when not on a terminal)
  observer doctor                  Diagnose the local setup
  observer where                   Print the paths Observer uses
  observer version                 Print the version

Options
  --plugin        With "install codex": install as a Codex plugin instead of
                  writing hooks directly, so it appears in the ChatGPT desktop
                  app's Plugins directory.
  --probe         With "config": ask OpenCode for its model list instead of
                  reading the on-disk catalogue. Slower, but picks up models
                  from providers declared only in opencode.json.

Environment
  NO_COLOR        Draw the config UI without colour. FORCE_COLOR=1 turns it on
                  where the terminal is not detected as one.

Hosts
  ${HOSTS.join(", ")}

Everything is local: the daemon binds to 127.0.0.1 and data lives in ${dataDir()}
`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      print(HELP)
      return 0

    case "version":
    case "--version":
    case "-v":
      print(VERSION)
      return 0

    case "start": {
      const portIndex = rest.indexOf("--port")
      const port = portIndex >= 0 ? Number(rest[portIndex + 1]) : undefined
      const result = await start(Number.isFinite(port) ? port : undefined)
      print(`Observer is running at ${result.url}`)
      print(`Open the canvas with: observer open`)
      return 0
    }

    case "stop": {
      const stopped = await stop()
      print(stopped ? "Observer daemon stopped." : "Observer daemon was not running.")
      return 0
    }

    case "status": {
      const result = await status()
      print(result.running ? `running   ${result.url} (${result.events ?? 0} events)` : `stopped   ${result.url}`)
      if (result.detail) print(`          ${result.detail}`)
      if (result.faults && result.faults > 0) {
        print(`          ${result.faults} deliveries could not be recorded - run: observer doctor`)
      }
      print("")
      print("Integrations")
      for (const host of HOSTS) {
        const installed = isInstalled(host)
        print(`  ${pad(HOST_CAPABILITIES[host].label, 20)} ${installed ? "installed" : "not installed"}`)
      }
      if (isCodexPluginInstalled()) print(`  ${pad("Codex (plugin)", 20)} installed`)
      return 0
    }

    case "open": {
      const result = await status()
      if (!result.running) {
        print("Observer is not running. Start it with: observer start")
        return 1
      }
      // The canvas stays bound to the harness that opened it, so there is no
      // harness picker in the UI.
      const explicit = rest.includes("--host") ? rest[rest.indexOf("--host") + 1] : undefined
      const sessionArg = rest.includes("--session") ? rest[rest.indexOf("--session") + 1] : undefined
      const detected = rest.includes("--all") ? undefined : ((explicit as HostId | undefined) ?? detectHarness())
      const host = detected && (HOSTS as string[]).includes(detected) ? detected : undefined
      const url = canvasUrl(result.url, { host, session: sessionArg ?? detectSession() })
      openBrowser(url)
      print(`Opening ${url}`)
      if (host) print(`Connected to ${HOST_CAPABILITIES[host].label}.`)
      else print("No harness detected; showing every session. Use --host <harness> to bind explicitly.")
      return 0
    }

    case "install":
    case "uninstall": {
      const asPlugin = rest.includes("--plugin")
      const hosts = parseHosts(rest)
      if (hosts.length === 0) {
        printError(`Specify one or more hosts (${HOSTS.join(", ")}) or "all".`)
        return 1
      }
      for (const host of hosts) {
        // Codex can take Observer as a packaged plugin instead of raw hooks.
        const usePlugin = asPlugin && host === "codex"
        const result = usePlugin
          ? command === "install"
            ? installCodexPlugin(VERSION)
            : uninstallCodexPlugin()
          : command === "install"
            ? install(host)
            : uninstall(host)
        const label = usePlugin ? "Codex (plugin)" : HOST_CAPABILITIES[host].label
        print(`${pad(label, 20)} ${pad(result.action, 10)} ${result.path}`)
        for (const note of result.notes) print(`  - ${note}`)

        // Running both Codex integrations at once would report every event
        // twice, so say so rather than silently doubling the data.
        if (command === "install" && host === "codex") {
          const other = usePlugin
            ? isInstalled("codex") && "observer uninstall codex"
            : isCodexPluginInstalled() && "observer uninstall codex --plugin"
          if (other) {
            print(`  ! Codex is also configured the other way, which would record every event twice.`)
            print(`    Remove one with: ${other}`)
          }
        }
      }
      if (asPlugin && !hosts.includes("codex")) {
        print("")
        print("--plugin only applies to codex; other hosts were configured normally.")
      }
      if (command === "install") {
        print("")
        print("Start the daemon so hooks have somewhere to report:")
        print("  observer start && observer open")
      }
      return 0
    }

    case "config":
      return await runConfig(rest.includes("--probe") ? { probeHost: true } : {})

    case "doctor":
      return doctor()

    case "where": {
      print(`version   ${VERSION}`)
      print(`data      ${dataDir()}`)
      print(`database  ${databasePath()}`)
      print(`config    ${configPath()}`)
      print(`spool     ${spoolDir()}`)
      print(`log       ${logPath()}`)
      print(`emitter   ${emitterPath()}`)
      print(`daemon    ${daemonPath()}`)
      for (const host of HOSTS) print(`${pad(host, 10)}${hostConfigPath(host)}`)
      print(`${pad("codex+", 10)}${codexPluginDir()}`)
      print(`${pad("market", 10)}${personalMarketplacePath()}`)
      return 0
    }

    default:
      printError(`Unknown command: ${command}`)
      print(HELP)
      return 1
  }
}

async function doctor(): Promise<number> {
  let problems = 0
  const check = (ok: boolean, label: string, hint?: string): void => {
    print(`${ok ? "ok  " : "FAIL"}  ${label}`)
    if (!ok) {
      problems++
      if (hint) print(`      ${hint}`)
    }
  }

  print(`Observer ${VERSION}`)
  print("")
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? 0)
  const nodeMinor = Number(process.versions.node.split(".")[1] ?? 0)
  check(
    nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5),
    `Node ${process.versions.node}`,
    "Observer needs Node 22.5 or newer for the built-in node:sqlite module.",
  )

  check(existsSync(emitterPath()), `hook emitter present`, `Missing ${emitterPath()} - reinstall Observer.`)
  check(existsSync(daemonPath()), `daemon present`, `Missing ${daemonPath()} - reinstall Observer.`)
  check(existsSync(opencodePluginSource()), `OpenCode plugin source present`)

  const daemon = await status()
  check(daemon.running, `daemon reachable at ${daemon.url}`, "Start it with `observer start`.")

  const config = loadConfig()
  check(config.token.length >= 20, "auth token configured")

  print("")
  print("Integrations")
  for (const host of HOSTS) {
    const installed = isInstalled(host)
    const events = host === "opencode" ? "plugin" : `${HOST_EVENTS[host].length} events`
    print(`  ${pad(HOST_CAPABILITIES[host].label, 20)} ${pad(installed ? "installed" : "not installed", 16)}${events}`)
    if (!installed) print(`      install with: observer install ${host}`)
  }
  print(
    `  ${pad("Codex (plugin)", 20)} ${pad(isCodexPluginInstalled() ? "installed" : "not installed", 16)}${CODEX_PLUGIN_NAME}`,
  )
  if (isCodexPluginInstalled()) print(`      ${codexPluginDir()}`)
  else print(`      install with: observer install codex --plugin`)

  print("")
  print("Capture settings")
  for (const [key, enabled] of Object.entries(config.capture)) {
    print(`  ${pad(key, 20)} ${enabled ? "on" : "off"}`)
  }
  print(`  ${pad("redaction", 20)} ${config.redaction.enabled ? "on" : "off"}`)
  print(`  ${pad("retentionDays", 20)} ${config.retentionDays}`)

  // Seats get a section here as well as their own UI because this is where a
  // user looks when an employee is not running the model they configured, and
  // the answer is usually `control` being off rather than anything broken.
  const seats = diagnoseSeats(config.seats)
  const seated = Object.keys(config.seats.employees).length
  print("")
  print("Seats")
  print(`  ${pad("control", 20)} ${config.seats.control ? "on" : "off"}`)
  print(`  ${pad("configured", 20)} ${seated} employee${seated === 1 ? "" : "s"}`)
  print(`  ${pad("in effect", 20)} ${seats.effective ? "yes" : "no"}`)
  if (config.seats.control)
    print(`  ${pad("applies to", 20)} \`general\` delegations only - any other agent keeps its own prompt, tools and model`)
  for (const issue of seats.issues) {
    if (issue.severity === "error") problems++
    print(`  ${pad(issue.severity, 20)} ${issue.message}`)
  }
  if (seated === 0) print(`      configure with: observer config`)

  // Deliveries that never became events. This is the section that explains a
  // canvas which stays empty while agents are clearly running.
  const delivery = daemon.running ? await diagnostics() : undefined
  if (delivery) {
    print("")
    print("Delivery health")
    print(`  ${pad("accepted", 20)} ${delivery.accepted}`)
    for (const [reason, count] of Object.entries(delivery.counters)) {
      if (count === 0) continue
      const label = REASON_HELP[reason] ?? ""
      print(`  ${pad(reason, 20)} ${pad(String(count), 8)}${label}`)
    }
    if (delivery.faults > 0) {
      problems++
      print("")
      print(`Recent deliveries Observer could not record (${delivery.faults} total)`)
      for (const sample of delivery.recent.slice(0, 8)) {
        const keys = sample.payloadKeys.length > 0 ? `keys: ${sample.payloadKeys.join(", ")}` : "empty payload"
        print(`  ${pad(sample.host, 10)}${pad(sample.event, 22)}${pad(sample.reason, 11)}${keys}`)
        if (sample.detail) print(`      ${sample.detail}`)
      }
      print("")
      print("  unmapped  usually means the host sent an event Observer does not translate yet.")
      print("  malformed means the hook payload was not valid JSON when it reached the emitter.")
    }
    const stale = Object.entries(delivery.lastAcceptedByHost)
    if (stale.length > 0) {
      print("")
      print("Last accepted delivery")
      for (const [host, at] of stale) {
        print(`  ${pad(host, 20)} ${new Date(at).toLocaleString()}`)
      }
    }
  }

  print("")
  print(problems === 0 ? "No problems found." : `${problems} problem(s) found.`)
  return problems === 0 ? 0 : 1
}

const REASON_HELP: Record<string, string> = {
  unmapped: "host events Observer did not translate",
  ignored: "recognised but not drawn on the canvas (expected)",
  malformed: "payload was not valid JSON",
  invalid: "failed schema validation",
  filtered: "removed by capture settings",
  duplicate: "already recorded (expected on replay)",
}

function parseHosts(args: string[]): HostId[] {
  if (args.includes("all") || args.includes("--all")) return [...HOSTS]
  return args.filter((value): value is HostId => (HOSTS as string[]).includes(value))
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width, " ")
}

function print(message: string): void {
  process.stdout.write(`${message}\n`)
}

function printError(message: string): void {
  process.stderr.write(`${message}\n`)
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    printError(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })

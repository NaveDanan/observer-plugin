#!/usr/bin/env node
import { startDaemon } from "./index.js"

const portArg = process.argv.indexOf("--port")
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : undefined

startDaemon({ port: Number.isFinite(port) ? port : undefined })
  .then((daemon) => {
    process.stdout.write(`observer daemon listening on ${daemon.url}\n`)
    const shutdown = (): void => {
      daemon
        .close()
        .catch(() => undefined)
        .finally(() => process.exit(0))
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  })
  .catch((error: unknown) => {
    process.stderr.write(`observer daemon failed to start: ${String(error)}\n`)
    process.exit(1)
  })

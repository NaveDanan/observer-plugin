import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Observer keeps everything under a single private directory so that a user can
 * audit or delete all captured data with one `rm -rf`.
 */
export function dataDir(): string {
  return process.env.OBSERVER_HOME && process.env.OBSERVER_HOME.length > 0
    ? process.env.OBSERVER_HOME
    : join(homedir(), ".observer")
}

export function databasePath(): string {
  return join(dataDir(), "observer.db")
}

export function configPath(): string {
  return join(dataDir(), "config.json")
}

export function spoolDir(): string {
  return join(dataDir(), "spool")
}

export function logPath(): string {
  return join(dataDir(), "daemon.log")
}

export function pidPath(): string {
  return join(dataDir(), "daemon.pid")
}

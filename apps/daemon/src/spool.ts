import { readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import type { HookRequest } from "@observer-ai/adapters"
import { spoolDir } from "@observer-ai/storage"
import { HostId } from "@observer-ai/protocol"
import type { Pipeline } from "./pipeline.js"

/**
 * Replays hook deliveries captured while the daemon was down.
 *
 * `observer-emit` never fails a hook: if it cannot reach the daemon it appends
 * the delivery to a JSONL spool. Event ids are derived from the delivery id, so
 * replaying a file twice is harmless.
 */
export function drainSpool(pipeline: Pipeline): { files: number; accepted: number; duplicates: number } {
  const dir = spoolDir()
  let files: string[]
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"))
  } catch {
    return { files: 0, accepted: 0, duplicates: 0 }
  }

  let accepted = 0
  let duplicates = 0
  for (const name of files) {
    const path = join(dir, name)
    // Claim the file first so a concurrently running hook keeps appending to a
    // fresh one instead of racing us.
    const claimed = `${path}.draining`
    try {
      renameSync(path, claimed)
    } catch {
      continue
    }
    let content = ""
    try {
      content = readFileSync(claimed, "utf8")
    } catch {
      continue
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const request = parseRequest(trimmed)
      if (!request) continue
      const result = pipeline.ingestHook(request)
      accepted += result.accepted
      duplicates += result.duplicates
    }
    try {
      unlinkSync(claimed)
    } catch {
      // Leaving the file behind only costs a duplicate pass next time.
    }
  }
  return { files: files.length, accepted, duplicates }
}

function parseRequest(line: string): HookRequest | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<HookRequest>
    if (!parsed.host || !parsed.event || !parsed.deliveryId) return undefined
    if (!HostId.safeParse(parsed.host).success) return undefined
    return {
      host: parsed.host,
      event: parsed.event,
      payload: parsed.payload,
      deliveryId: parsed.deliveryId,
      workspaceRoot: parsed.workspaceRoot,
      hostVersion: parsed.hostVersion,
      context: parsed.context,
    }
  } catch {
    return undefined
  }
}

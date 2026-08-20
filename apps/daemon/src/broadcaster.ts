import type { Change, ServerMessage } from "@observer-ai/protocol"

interface Client {
  send(data: string): void
  close(): void
}

interface Buffered {
  cursor: number
  changes: Change[]
}

/**
 * Fan-out for live UI updates.
 *
 * Keeps a bounded replay buffer so a browser that reconnects after a short
 * network blip resumes exactly where it left off; anything older triggers an
 * explicit `resync` rather than silently dropping updates.
 */
export class Broadcaster {
  private readonly clients = new Set<Client>()
  private readonly buffer: Buffered[] = []
  private readonly capacity: number
  private cursorValue = 0

  constructor(capacity = 2_000) {
    this.capacity = capacity
  }

  get cursor(): number {
    return this.cursorValue
  }

  get size(): number {
    return this.clients.size
  }

  add(client: Client): void {
    this.clients.add(client)
  }

  remove(client: Client): void {
    this.clients.delete(client)
  }

  publish(changes: Change[]): void {
    if (changes.length === 0) return
    this.cursorValue++
    const entry: Buffered = { cursor: this.cursorValue, changes }
    this.buffer.push(entry)
    if (this.buffer.length > this.capacity) this.buffer.shift()
    const message: ServerMessage = { type: "changes", cursor: entry.cursor, changes }
    const payload = JSON.stringify(message)
    for (const client of this.clients) {
      try {
        client.send(payload)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  /**
   * Replays buffered changes for a reconnecting client.
   * Returns false when the gap is too large and a full refetch is required.
   */
  replay(client: Client, fromCursor: number): boolean {
    if (fromCursor === this.cursorValue) return true
    const oldest = this.buffer[0]
    if (!oldest || fromCursor < oldest.cursor - 1) return false
    for (const entry of this.buffer) {
      if (entry.cursor <= fromCursor) continue
      const message: ServerMessage = { type: "changes", cursor: entry.cursor, changes: entry.changes }
      client.send(JSON.stringify(message))
    }
    return true
  }

  closeAll(): void {
    for (const client of this.clients) {
      try {
        client.close()
      } catch {
        // best effort
      }
    }
    this.clients.clear()
  }
}

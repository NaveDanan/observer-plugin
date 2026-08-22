import { randomUUID } from "node:crypto"
import { type AdapterEvent, type HookRequest, adapterIdFor, ignoresHook, normalizeHook } from "@observer-ai/adapters"
import { type RedactionOptions, redactText, redactValue, reduce } from "@observer-ai/core"
import { type Change, type EventBody, type IngestEvent, IngestEvent as IngestEventSchema } from "@observer-ai/protocol"
import type { Store } from "@observer-ai/storage"
import type { CaptureConfig, ObserverConfig } from "./config.js"
import type { Diagnostics, DropReason } from "./diagnostics.js"

export interface PipelineOptions {
  store: Store
  config: ObserverConfig
  onChanges: (changes: Change[]) => void
  diagnostics?: Diagnostics
}

export interface IngestResult {
  accepted: number
  duplicates: number
  rejected: number
}

/**
 * Turns host deliveries into persisted state and UI updates.
 *
 * Order of operations matters: capture policy runs before redaction, and both
 * run before anything touches the database, so disabled or secret content is
 * never written at all.
 *
 * Every path that discards a delivery reports to `Diagnostics`. Silent loss is
 * the failure mode most likely to look like "the agent did nothing".
 */
export class Pipeline {
  private readonly store: Store
  private readonly config: ObserverConfig
  private readonly onChanges: (changes: Change[]) => void
  private readonly diagnostics: Diagnostics | undefined

  constructor(options: PipelineOptions) {
    this.store = options.store
    this.config = options.config
    this.onChanges = options.onChanges
    this.diagnostics = options.diagnostics
  }

  /** Handles one hook delivery from `observer-emit` or a host plugin. */
  ingestHook(request: HookRequest): IngestResult {
    const adapterEvents = normalizeHook(request)
    if (adapterEvents.length === 0) {
      this.diagnostics?.record({
        host: request.host,
        event: request.event,
        reason: emptyResultReason(request),
        detail: request.payloadError,
        payload: request.payload,
      })
      return { accepted: 0, duplicates: 0, rejected: 1 }
    }
    const events = adapterEvents.map((event, index) =>
      this.toIngestEvent(event, request, `${request.deliveryId}#${index}`),
    )
    return this.ingestEvents(events, request.event)
  }

  ingestEvents(events: IngestEvent[], sourceEvent?: string): IngestResult {
    const result: IngestResult = { accepted: 0, duplicates: 0, rejected: 0 }
    const changes: Change[] = []

    this.store.transaction(() => {
      for (const candidate of events) {
        const parsed = IngestEventSchema.safeParse(candidate)
        if (!parsed.success) {
          result.rejected++
          this.diagnostics?.record({
            host: String(candidate.host ?? "unknown"),
            event: sourceEvent ?? String(candidate.body?.kind ?? "unknown"),
            reason: "invalid",
            detail: parsed.error.issues[0]?.message,
            payload: candidate.body,
          })
          continue
        }
        const event = parsed.data
        const body = this.applyPolicy(event.body)
        if (!body) {
          result.rejected++
          this.diagnostics?.record({
            host: event.host,
            event: sourceEvent ?? event.body.kind,
            reason: "filtered",
          })
          continue
        }
        const stored = this.store.appendEvent({
          ...event,
          body,
          raw: this.config.capture.rawEvents ? event.raw : undefined,
          id: event.id ?? randomUUID(),
          at: event.at ?? Date.now(),
        })
        if (!stored) {
          result.duplicates++
          this.diagnostics?.record({ host: event.host, event: event.body.kind, reason: "duplicate" })
          continue
        }
        changes.push(...reduce(this.store, stored))
        result.accepted++
        this.diagnostics?.markAccepted(event.host, stored.receivedAt)
      }
    })

    if (changes.length > 0) this.onChanges(changes)
    return result
  }

  captureCoordinationPrompt(text: string | null | undefined): string | null {
    if (!text || !this.config.capture.prompts) return null
    return redactText(text, {
      enabled: this.config.redaction.enabled,
      maxTextLength: this.config.redaction.maxTextLength,
    })
  }

  captureCoordinationMessage(text: string): string | null {
    if (!this.config.capture.messages) return null
    return redactText(text, {
      enabled: this.config.redaction.enabled,
      maxTextLength: this.config.redaction.maxTextLength,
    })
  }

  private toIngestEvent(event: AdapterEvent, request: HookRequest, id: string): IngestEvent {
    return {
      id,
      host: request.host,
      hostVersion: request.hostVersion,
      adapter: adapterIdFor(request.host),
      workspaceRoot: request.workspaceRoot ?? process.cwd(),
      sessionKey: event.sessionKey,
      agentKey: event.agentKey ?? "main",
      at: event.at ?? Date.now(),
      provenance: event.provenance ?? "authoritative",
      body: event.body,
      raw: this.config.capture.rawEvents ? { event: request.event, payload: request.payload } : undefined,
    }
  }

  /**
   * Applies capture switches and redaction.
   * Returns `undefined` when the event must be dropped entirely.
   */
  private applyPolicy(body: EventBody): EventBody | undefined {
    const capture = this.config.capture
    const redaction: RedactionOptions = {
      enabled: this.config.redaction.enabled,
      maxTextLength: this.config.redaction.maxTextLength,
    }
    const clean = (value: string): string => redactText(value, redaction)

    switch (body.kind) {
      case "message.user":
      case "message.assistant":
        if (!capture.messages) return undefined
        return { ...body, text: clean(body.text) }

      case "message.assistant.delta":
        if (!capture.messages) return undefined
        return { ...body, delta: clean(body.delta) }

      case "message.reasoning":
        if (!capture.messages || !capture.reasoning) return undefined
        return { ...body, text: clean(body.text) }

      case "tool.started":
        return {
          ...body,
          input: capture.toolInput ? redactValue(body.input, redaction) : undefined,
        }

      case "tool.finished":
        return {
          ...body,
          output: capture.toolOutput && body.output ? clean(body.output) : undefined,
          error: body.error ? clean(body.error) : undefined,
        }

      case "prompt.fragment":
        if (!capture.prompts) return undefined
        return { ...body, text: body.text ? clean(body.text) : undefined }

      case "agent.started":
        return {
          ...body,
          prompt: capture.prompts && body.prompt ? clean(body.prompt) : undefined,
        }

      case "agent.stopped":
        return { ...body, summary: capture.messages && body.summary ? clean(body.summary) : undefined }

      case "goal.updated":
        return { ...body, objective: clean(body.objective) }

      case "todos.updated":
        return { ...body, todos: body.todos.map((todo) => ({ ...todo, content: clean(todo.content) })) }

      case "plan.updated":
        return { ...body, steps: body.steps.map((step) => ({ ...step, step: clean(step.step) })) }

      default:
        return body
    }
  }
}

export function describeCapture(capture: CaptureConfig): string[] {
  return Object.entries(capture)
    .filter(([, enabled]) => !enabled)
    .map(([key]) => key)
}

/**
 * Explains why a delivery produced no events.
 *
 * Three different situations arrive here as the same empty array, and each
 * needs a different response from the user: a payload the emitter could not
 * parse is a broken hook, an event the adapter knowingly draws nothing for is
 * routine, and anything else is coverage Observer is missing. Order matters -
 * a payload that failed to parse cannot be trusted to say what it was, so
 * `malformed` is decided first.
 */
function emptyResultReason(request: HookRequest): DropReason {
  if (request.payloadError) return "malformed"
  return ignoresHook(request) ? "ignored" : "unmapped"
}

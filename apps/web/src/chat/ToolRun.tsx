import { useState } from "react"
import {
  BotIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  EyeIcon,
  ListChecksIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react"
import type { ToolCallEntity } from "@observer-ai/protocol"
import { toolAction, type ToolAction } from "./timeline"

/**
 * A run of tool calls, inline in the transcript.
 *
 * Deliberately monochrome. A turn can contain forty tool calls, and giving
 * each kind its own accent turns the transcript into a barcode that the
 * message text has to compete with — the tools are what the agent did between
 * sentences, so they should read as chrome. Colour is spent on the one thing
 * that must not be missed: a call that failed.
 *
 * Everything is collapsed by default for the same reason. The summary answers
 * "did it do the thing?", which is the question being asked ninety-nine times
 * out of a hundred; the arguments and output are one click away for the
 * hundredth.
 */

const ACTION_ICON: Record<ToolAction, typeof WrenchIcon> = {
  read: EyeIcon,
  edit: SquarePenIcon,
  command: TerminalIcon,
  search: SearchIcon,
  task: BotIcon,
  todo: ListChecksIcon,
  other: WrenchIcon,
}

export function ToolRun({
  calls,
  action,
  summary,
  failed,
  running,
}: {
  calls: ToolCallEntity[]
  action: ToolAction
  summary: string
  failed: boolean
  running: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = failed ? CircleAlertIcon : ACTION_ICON[action]
  // A single call expands straight to its own detail; there is no list worth
  // showing between the summary and the one thing it summarises.
  const single = calls.length === 1 ? calls[0] : undefined

  return (
    <li className={`tool-run${failed ? " is-failed" : ""}${running ? " is-running" : ""}`}>
      <button type="button" className="tool-run-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon size={14} className="tool-run-icon" aria-hidden="true" />
        <span className="tool-run-summary">{summary}</span>
        {calls.length > 1 && <span className="count">{calls.length}</span>}
        {running && <span className="pulse-dot" aria-label="still running" />}
        <ChevronDownIcon size={12} className={`tool-run-chevron${open ? " is-open" : ""}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="tool-run-body">
          {single ? (
            <ToolCallDetail call={single} />
          ) : (
            <ul className="tool-run-list">
              {calls.map((call) => (
                <ToolCallItem key={call.id} call={call} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

/** One call inside an expanded run: its own name, its own disclosure. */
function ToolCallItem({ call }: { call: ToolCallEntity }): JSX.Element {
  const [open, setOpen] = useState(false)
  const Icon = call.status === "error" ? CircleAlertIcon : ACTION_ICON[toolAction(call.tool)]
  return (
    <li className={`tool-call status-${call.status}`}>
      <button type="button" className="tool-call-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon size={13} className="tool-run-icon" aria-hidden="true" />
        <span className="mono tool-call-name">{call.title ?? call.tool}</span>
        {call.durationMs !== null && <span className="muted small">{formatDuration(call.durationMs)}</span>}
        <ChevronDownIcon size={12} className={`tool-run-chevron${open ? " is-open" : ""}`} aria-hidden="true" />
      </button>
      {open && <ToolCallDetail call={call} />}
    </li>
  )
}

function ToolCallDetail({ call }: { call: ToolCallEntity }): JSX.Element {
  const input = formatInput(call.input)
  return (
    <div className="tool-detail">
      <p className="tool-detail-meta">
        <span className="mono">{call.tool}</span>
        <span className={`badge status-${call.status}`}>{call.status}</span>
        {call.durationMs !== null && <span className="muted small">{formatDuration(call.durationMs)}</span>}
      </p>
      {input && (
        <>
          <h4>Input</h4>
          <pre className="pre">{input}</pre>
        </>
      )}
      {call.output && (
        <>
          <h4>Output</h4>
          <pre className="pre">{call.output}</pre>
        </>
      )}
      {call.error && (
        <>
          <h4>Error</h4>
          <pre className="pre error">{call.error}</pre>
        </>
      )}
      {/* A call that is still running has no output yet, which is a different
          thing from having produced none. Saying so beats an empty panel. */}
      {!input && !call.output && !call.error && (
        <p className="muted small">{call.status === "running" ? "Still running." : "Nothing was captured for this call."}</p>
      )}
    </div>
  )
}

function formatInput(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined
  if (typeof input === "string") return input.length > 0 ? input : undefined
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    // Circular or otherwise unserialisable payloads must not take the panel
    // down with them.
    return String(input)
  }
}

/** Milliseconds are the right unit until they stop being readable. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

import { useMemo, useState, type CSSProperties } from "react"
import {
  BotIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  FileTextIcon,
  ListChecksIcon,
  SearchIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react"
import type { ToolCallEntity } from "@observer-ai/protocol"
import { CopyButton } from "./CodeBlock"
import { parseAnsiLines, type AnsiSegment } from "./ansi"
import { FileIcon } from "./FileIcon"
import { useHighlighted } from "./highlighter"
import { toolAction, type ToolAction } from "./timeline"
import {
  baseName,
  contentLines,
  describeToolCall,
  type DiffRow,
  formatBytes,
  formatCount,
  formatDuration,
  formatStarted,
  type StepBody,
  type PatchFileChange,
  type ToolStep,
} from "./toolStep"

/**
 * A run of tool calls, inline in the transcript.
 *
 * Each call is a **step**: one line saying what the agent did and how it went,
 * which expands into a card showing the arguments it was given and the output
 * it produced — a file with its own line gutter, a terminal, a list of matches.
 * That is the whole point of the surface: "did it do the thing?" is answered by
 * the row, and "what exactly came back?" by the card, without the reader
 * leaving the sentence that explains why either happened.
 *
 * Steps are listed rather than summarised while a run is short, because
 * "Read 4 files" hides the four names that are the actual answer most of the
 * time. Past `SUMMARISE_ABOVE` that flips: a run of forty calls listed in full
 * buries the reply underneath it, so the run collapses to its count and the
 * list moves one click away.
 *
 * Deliberately monochrome. A turn can contain forty tool calls, and giving
 * each kind its own accent turns the transcript into a barcode that the
 * message text has to compete with. Colour is spent on the one thing that must
 * not be missed: a call that failed.
 */

const ACTION_ICON: Record<ToolAction, typeof WrenchIcon> = {
  read: FileTextIcon,
  edit: SquarePenIcon,
  command: TerminalIcon,
  search: SearchIcon,
  task: BotIcon,
  todo: ListChecksIcon,
  other: WrenchIcon,
}

/** Above this many calls a run shows its count instead of its steps. */
const SUMMARISE_ABOVE = 6

/** How much of a body is shown before the reader has to ask for the rest. */
const PREVIEW_LINES = 18

/**
 * Diffs get more room: their lines are the point of the card, and a hunk cut
 * off at eighteen usually hides the addition that answers the removal.
 */
const DIFF_PREVIEW_LINES = 32

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
  const long = calls.length > SUMMARISE_ABOVE
  const Icon = failed ? CircleAlertIcon : ACTION_ICON[action]

  if (!long) {
    return (
      <li className={`tool-run${failed ? " is-failed" : ""}${running ? " is-running" : ""}`}>
        <ol className="steps">
          {calls.map((call) => (
            <Step key={call.id} call={call} />
          ))}
        </ol>
      </li>
    )
  }

  return (
    <li className={`tool-run${failed ? " is-failed" : ""}${running ? " is-running" : ""}`}>
      <button type="button" className="step-row is-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="step-icon-slot">
          <Icon size={14} className="step-icon" aria-hidden="true" />
          <ChevronDownIcon size={14} className="step-chevron" aria-hidden="true" />
        </span>
        <span className="step-title">{summary}</span>
        <span className="count">{calls.length}</span>
        {running && <span className="pulse-dot" aria-label="still running" />}
      </button>
      {open && (
        <ol className="steps is-nested">
          {calls.map((call) => (
            <Step key={call.id} call={call} />
          ))}
        </ol>
      )}
    </li>
  )
}

/**
 * One step: the collapsed sentence, and the card it opens into.
 *
 * The row swaps its own icon for a chevron on hover, so the affordance appears
 * exactly where the reader is already looking instead of parking a permanent
 * arrow on every one of forty rows.
 */
function Step({ call }: { call: ToolCallEntity }): JSX.Element {
  const [open, setOpen] = useState(false)
  const step = useMemo(() => describeToolCall(call), [call])

  if (step.patchFiles) return <PatchStep call={call} step={step} />

  return (
    <li className={`step status-${call.status}${open ? " is-expanded" : ""}`}>
      <button type="button" className="step-row" aria-expanded={open} onClick={() => setOpen(!open)} title={step.title}>
        <span className="step-icon-slot">
          <StepIcon step={step} tool={call.tool} />
          <ChevronDownIcon size={14} className="step-chevron" aria-hidden="true" />
        </span>
        <span className="step-title">
          {step.lead && <strong>{step.lead}</strong>}
          {step.lead ? <span className="mono step-arg">{step.title}</span> : step.title}
        </span>
        <Churn step={step} />
        {step.meta && <span className="step-meta">{step.meta}</span>}
        {step.running && <span className="pulse-dot" aria-label="still running" />}
      </button>
      {open && <StepCard step={step} tool={call.tool} />}
    </li>
  )
}

/** A patch is a file operation, not an input/output exchange. */
function PatchStep({ call, step }: { call: ToolCallEntity; step: ToolStep }): JSX.Element {
  const [open, setOpen] = useState(step.running)
  const files = step.patchFiles ?? []

  return (
    <li className={`step patch-step status-${call.status}${open ? " is-expanded" : ""}`}>
      <button type="button" className="step-row patch-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="step-icon-slot">
          <SquarePenIcon size={14} className="step-icon" aria-hidden="true" />
          <ChevronDownIcon size={14} className="step-chevron" aria-hidden="true" />
        </span>
        <span className="step-title">{step.title}</span>
        <Churn step={step} animated />
        {step.running && <span className="pulse-dot" aria-label="still running" />}
      </button>
      {open && (
        <ol className="patch-files">
          {files.map((file) => (
            <PatchFile key={`${file.operation}:${file.path}`} file={file} running={step.running} />
          ))}
        </ol>
      )}
    </li>
  )
}

function PatchFile({ file, running }: { file: PatchFileChange; running: boolean }): JSX.Element {
  const verb = file.operation === "add" ? "Add" : file.operation === "delete" ? "Delete" : "Edit"
  return (
    <li className={`patch-file${running ? " is-running" : ""}`} title={file.path}>
      <FileIcon path={file.path} className="file-icon" fallback={<FileTextIcon size={13} aria-hidden="true" />} />
      <span className="patch-file-title">
        {verb} <span className="mono">{baseName(file.path)}</span>
      </span>
      <PatchChurn added={file.added} removed={file.removed} animated={running} />
    </li>
  )
}

/** The expanded card: what it was given, what came back, and the receipts. */
function StepCard({ step, tool }: { step: ToolStep; tool: string }): JSX.Element {
  return (
    <div className="tool-card">
      {step.subject?.kind === "path" && (
        <div className="card-title-bar">
          <FileIcon
            path={step.subject.value}
            className="file-icon"
            fallback={<FileTextIcon size={13} aria-hidden="true" />}
          />
          <span className="mono card-path" title={step.subject.value}>
            {baseName(step.subject.value)}
          </span>
        </div>
      )}

      {step.subject?.kind === "command" && (
        <div className="card-command">
          <span className="term-prompt" aria-hidden="true">
            $
          </span>
          <code className="mono">{step.subject.value}</code>
        </div>
      )}

      {step.fields.length > 0 && (
        <dl className="card-fields">
          {step.fields.map((field) => (
            <div key={field.label} className="card-field">
              <dt>{field.label}</dt>
              <dd className={field.mono ? "mono" : undefined}>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {step.input && <BodyView body={step.input} label={step.inputLabel ?? (step.action === "edit" ? "Change" : "Input")} />}
      {step.output && <BodyView body={step.output} label="Output" />}

      {step.error && (
        <section className="card-section">
          <p className="card-label is-error">Error</p>
          <pre className="pre error">{step.error}</pre>
        </section>
      )}

      {!step.input && !step.output && !step.error && (
        <p className="card-empty muted small">
          {step.running ? "Still running." : `Nothing was captured for this ${tool} call.`}
        </p>
      )}

      <CardFooter step={step} />
    </div>
  )
}

/** Dispatches on what the body *is*: a file, a terminal, a list, a change. */
function BodyView({ body, label }: { body: StepBody; label: string }): JSX.Element {
  switch (body.kind) {
    case "code":
      return (
        <section className="card-section">
          <SectionHead label={label} text={body.text} />
          <CodeView text={body.text} language={body.language} firstLine={body.firstLine} />
        </section>
      )
    case "terminal":
      return (
        <section className="card-section">
          <SectionHead label={label} text={body.text} />
          <TerminalView text={body.text} />
        </section>
      )
    case "list":
      return (
        <section className="card-section">
          <SectionHead label={`${label} · ${formatCount(body.items.length, "line")}`} text={body.items.join("\n")} />
          <ListView items={body.items} />
        </section>
      )
    case "diff":
      return (
        <section className="card-section is-diff">
          <DiffView rows={body.rows} language={body.language} />
        </section>
      )
    default:
      return (
        <section className="card-section">
          <SectionHead label={label} text={body.text} />
          <pre className="pre card-text">{body.text}</pre>
        </section>
      )
  }
}

function SectionHead({ label, text }: { label: string; text: string }): JSX.Element {
  return (
    <div className="card-label-row">
      <p className="card-label">{label}</p>
      <CopyButton text={text} />
    </div>
  )
}

/**
 * File content with a real line gutter.
 *
 * The numbers are a CSS counter on Shiki's own `.line` spans rather than a
 * column of text: they cannot be selected, so copying a snippet out of the
 * viewer yields code, not code interleaved with line numbers. `firstLine`
 * seeds the counter, so a read of lines 400–460 is numbered 400–460.
 */
function CodeView({
  text,
  language,
  firstLine,
}: {
  text: string
  language: string | undefined
  firstLine: number
}): JSX.Element {
  const { shown, hidden, expand } = usePreview(text)
  const html = useHighlighted(shown, language, false)
  return (
    <>
      {html ? (
        <div
          className="code-view"
          style={{ counterReset: `line ${firstLine - 1}` }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        // The floor every failure mode lands on: same metrics, same gutter, no
        // colour. Swapping in the highlighted version must not move anything.
        <div className="code-view" style={{ counterReset: `line ${firstLine - 1}` }}>
          <pre className="shiki">
            <code>
              {shown.split("\n").map((line, index) => (
                <span className="line" key={`${index}:${line}`}>
                  {line}
                  {"\n"}
                </span>
              ))}
            </code>
          </pre>
        </div>
      )}
      {hidden > 0 && <ShowMore hidden={hidden} noun="line" onClick={expand} />}
    </>
  )
}

/**
 * Command output.
 *
 * Truncates from the *front*, unlike everything else here: a command that went
 * wrong says so in its last ten lines, and a card showing the first eighteen
 * lines of a build log has hidden the only part worth reading.
 */
function TerminalView({ text }: { text: string }): JSX.Element {
  const [full, setFull] = useState(false)
  const all = useMemo(() => parseAnsiLines(text.replace(/\n+$/, "")), [text])
  const hidden = full ? 0 : Math.max(0, all.length - PREVIEW_LINES)
  const shown = hidden > 0 ? all.slice(all.length - PREVIEW_LINES) : all
  return (
    <>
      {hidden > 0 && <ShowMore hidden={hidden} noun="earlier line" onClick={() => setFull(true)} />}
      <pre className="terminal-view">
        {shown.map((line, lineIndex) => (
          <span className="terminal-line" key={lineIndex}>
            {line.map((part, partIndex) => (
              <AnsiText key={partIndex} segment={part} />
            ))}
            {lineIndex < shown.length - 1 ? "\n" : null}
          </span>
        ))}
      </pre>
    </>
  )
}

function AnsiText({ segment }: { segment: AnsiSegment }): JSX.Element {
  const decoration = [segment.underline ? "underline" : "", segment.strike ? "line-through" : ""]
    .filter(Boolean)
    .join(" ")
  const style: CSSProperties = {
    color: segment.foreground,
    backgroundColor: segment.background,
    fontWeight: segment.bold ? 700 : undefined,
    fontStyle: segment.italic ? "italic" : undefined,
    opacity: segment.dim ? 0.65 : undefined,
    textDecoration: decoration || undefined,
  }
  return <span style={style}>{segment.text}</span>
}

function ListView({ items }: { items: string[] }): JSX.Element {
  const [full, setFull] = useState(false)
  const hidden = full ? 0 : Math.max(0, items.length - PREVIEW_LINES)
  const shown = hidden > 0 ? items.slice(0, PREVIEW_LINES) : items
  return (
    <>
      <ul className="output-list">
        {shown.map((item, index) => (
          <li key={`${index}:${item}`} className="mono">
            {item}
          </li>
        ))}
      </ul>
      {hidden > 0 && <ShowMore hidden={hidden} noun="line" onClick={() => setFull(true)} />}
    </>
  )
}

/**
 * An edit, as a diff.
 *
 * Removals and additions are shown against the context they sit in, signed and
 * tinted, because the question a reader has about an edit is "what changed?" —
 * and two adjacent blocks of before-and-after text make them answer it by eye.
 *
 * The whole diff is highlighted as one document and then split back into lines,
 * so a multi-line string or template literal is coloured correctly across the
 * lines it spans, which per-line highlighting cannot do.
 */
function DiffView({ rows, language }: { rows: DiffRow[]; language: string | undefined }): JSX.Element {
  const [full, setFull] = useState(false)
  const hidden = full ? 0 : Math.max(0, rows.length - DIFF_PREVIEW_LINES)
  const shown = hidden > 0 ? rows.slice(0, DIFF_PREVIEW_LINES) : rows
  const text = useMemo(() => shown.map((row) => row.text).join("\n"), [shown])
  const html = useHighlighted(text, language, false)
  const coloured = useMemo(() => (html === null ? null : splitHighlightedLines(html)), [html])
  const usable = coloured !== null && coloured.length === shown.length ? coloured : null

  return (
    <>
      <div className="diff-view">
        {shown.map((row, index) => (
          <div className={`diff-line ${DIFF_TONE[row.sign]}`} key={`${index}:${row.sign}${row.text}`}>
            <span className="diff-sign" aria-hidden="true">
              {row.sign}
            </span>
            {usable ? (
              <span className="diff-code shiki" dangerouslySetInnerHTML={{ __html: usable[index] as string }} />
            ) : (
              <span className="diff-code">{row.text}</span>
            )}
          </div>
        ))}
      </div>
      {hidden > 0 && <ShowMore hidden={hidden} noun="line" onClick={() => setFull(true)} />}
    </>
  )
}

const DIFF_TONE: Record<DiffRow["sign"], string> = {
  " ": "is-context",
  "-": "is-removed",
  "+": "is-added",
  "\\": "is-marker",
}

/**
 * Shiki emits one `.line` span per line; pulling their inner markup back out
 * lets each line be re-wrapped in its own signed, tinted row. Returns null if
 * the shape is ever not what we expect, and the caller falls back to plain
 * text rather than rendering half a diff.
 */
function splitHighlightedLines(html: string): string[] | null {
  if (typeof DOMParser === "undefined") return null
  const parsed = new DOMParser().parseFromString(html, "text/html")
  const lines = parsed.querySelectorAll("code > .line")
  if (lines.length === 0) return null
  return [...lines].map((line) => line.innerHTML)
}

function ShowMore({ hidden, noun, onClick }: { hidden: number; noun: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className="show-more" onClick={onClick}>
      Show {formatCount(hidden, noun)} more
    </button>
  )
}

/** Head-first truncation, and the toggle that undoes it. */
function usePreview(text: string): { shown: string; hidden: number; expand: () => void } {
  const [full, setFull] = useState(false)
  const all = contentLines(text)
  const hidden = full ? 0 : Math.max(0, all.length - PREVIEW_LINES)
  return {
    shown: hidden > 0 ? all.slice(0, PREVIEW_LINES).join("\n") : all.join("\n"),
    hidden,
    expand: () => setFull(true),
  }
}

/** `+7 −6`, in the only two colours this surface spends on anything. */
function Churn({ step, animated = false }: { step: ToolStep; animated?: boolean }): JSX.Element | null {
  if (step.churn === null) return null
  const { added, removed } = step.churn
  if ((added === null || added === 0) && (removed === null || removed === 0)) return null
  return <PatchChurn added={added} removed={removed} animated={animated && step.running} />
}

function PatchChurn({ added, removed, animated }: { added: number | null; removed: number | null; animated: boolean }): JSX.Element {
  return (
    <span className={`step-churn${animated ? " is-live" : ""}`}>
      {added !== null && added > 0 && (
        <span className="churn-window">
          <span key={added} className="churn-add">+{added}</span>
        </span>
      )}
      {removed !== null && removed > 0 && (
        <span className="churn-window">
          <span key={removed} className="churn-del">-{removed}</span>
        </span>
      )}
    </span>
  )
}

/**
 * The step's mark: the file's own type icon when the step is about a file, and
 * the action's glyph otherwise. A row of TypeScript, React and JSON marks is
 * scannable in a way that eight identical page outlines is not.
 */
function StepIcon({ step, tool }: { step: ToolStep; tool: string }): JSX.Element {
  const Icon = step.failed ? CircleAlertIcon : ACTION_ICON[toolAction(tool)]
  const glyph = <Icon size={14} className="step-icon" aria-hidden="true" />
  if (step.failed || step.subject?.kind !== "path") return glyph
  return <FileIcon path={step.subject.value} className="step-icon file-icon" fallback={glyph} />
}

/**
 * The receipts: when it started, how long it took, how much came back.
 *
 * Absent rather than zero — a call with no output has no output figure at all,
 * instead of a "0 lines" that claims a measurement we never made.
 */
function CardFooter({ step }: { step: ToolStep }): JSX.Element {
  const { startedAt, durationMs, lines, bytes } = step.stats
  return (
    <div className="card-footer">
      <span>
        Started <span className="footer-val">{formatStarted(startedAt)}</span>
      </span>
      {durationMs !== null && (
        <span>
          Duration <span className="footer-val">{formatDuration(durationMs)}</span>
        </span>
      )}
      {lines !== null && bytes !== null && (
        <span>
          Output{" "}
          <span className="footer-val">
            {formatCount(lines, "line")} · {formatBytes(bytes)}
          </span>
        </span>
      )}
    </div>
  )
}

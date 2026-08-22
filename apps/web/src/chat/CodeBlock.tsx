import { useEffect, useRef, useState } from "react"
import { CheckIcon, CopyIcon, WrapTextIcon } from "lucide-react"
import { useHighlighted } from "./highlighter"

export interface CodeBlockProps {
  code: string
  /** The raw fence tag, as written. `undefined` for an untagged fence. */
  language: string | undefined
  /** A filename from the fence meta (```` ```ts title="x.ts" ````), if given. */
  filename?: string | undefined
  /** True while the enclosing message is still arriving. */
  streaming?: boolean
}

/**
 * One fenced code block, with editor chrome.
 *
 * The chrome — a titled header, a wrap toggle, a copy button — exists because
 * a code block in a 380px panel is almost always too wide. Without a wrap
 * toggle the reader's only option is a horizontal scrollbar on a nested
 * element inside a vertical scroller, which is a miserable thing to hit; and
 * without a copy button the alternative is a drag-select that catches the
 * prose above it. Both are off by default: pre-wrapped code lies about its
 * line structure, so the reader opts into that trade rather than being handed
 * it.
 *
 * Highlighted output is injected as HTML. Shiki's output is generated from a
 * grammar rather than from the model's text — it is a tree of `<span>`s with
 * `style` colours and no attributes that can execute — and the code itself is
 * escaped on the way in. The unhighlighted fallback below stays a React child
 * so the pre-colour render is escaped by React itself.
 */
export function CodeBlock({ code, language, filename, streaming = false }: CodeBlockProps): JSX.Element {
  const [wrapped, setWrapped] = useState(false)
  const html = useHighlighted(code, language, streaming)
  const label = filename ?? (language && language.trim().length > 0 ? language : "text")

  return (
    <div className="code-block" data-wrapped={wrapped ? "true" : "false"}>
      <div className="code-block-head">
        <span className="code-block-lang" title={filename ? `${filename} · ${language ?? "text"}` : undefined}>
          {label}
        </span>
        <div className="code-block-tools">
          <button
            type="button"
            className={`code-block-btn${wrapped ? " is-on" : ""}`}
            aria-pressed={wrapped}
            title={wrapped ? "Stop wrapping lines" : "Wrap long lines"}
            onClick={() => setWrapped((value) => !value)}
          >
            <WrapTextIcon size={13} aria-hidden="true" />
            <span className="sr-only">Wrap long lines</span>
          </button>
          <CopyButton text={code} />
        </div>
      </div>
      {html ? (
        <div className="code-block-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="code-block-body">
          {/* The floor every failure mode lands on: the same box, the same
              metrics, no colour. Swapping this for the highlighted version
              must not move anything on screen. */}
          <pre className="shiki">
            <code>{code}</code>
          </pre>
        </div>
      )}
    </div>
  )
}

/**
 * Copies `text`, and says so for long enough to be believed.
 *
 * The confirmation is the same button rather than a toast: the reader is
 * looking at the button they just pressed, and a notification elsewhere on
 * screen makes them look away to learn something they already suspect.
 */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  // A copy landing just before unmount would otherwise set state on a dead
  // component, and leave the timer running after the panel closes.
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1200)
      })
      // A denied clipboard permission is not worth an error surface; the
      // button simply does not confirm, and the reader selects by hand.
      .catch(() => undefined)
  }

  return (
    <button type="button" className="code-block-btn" onClick={copy} title={copied ? "Copied" : label}>
      {copied ? <CheckIcon size={13} aria-hidden="true" /> : <CopyIcon size={13} aria-hidden="true" />}
      <span className="sr-only">{copied ? "Copied" : label}</span>
    </button>
  )
}

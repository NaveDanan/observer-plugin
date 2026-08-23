import { useState } from "react"
import { ChevronDownIcon, CircleDashedIcon } from "lucide-react"
import type { MessageEntity } from "@observer-ai/protocol"
import { ChatMarkdown } from "./ChatMarkdown"
import type { InlineVocabulary } from "./InlineVocabulary"

/**
 * A reasoning message, as a step.
 *
 * Thinking is not a reply. Rendered as a bubble it competes with the sentences
 * the agent actually said, and a long think can push the answer off the screen
 * entirely — so it sits on the same one-line rail as the tool calls it is
 * interleaved with, saying only how long it took, and opens into the text for
 * the reader who wants it.
 *
 * The duration is the message's own lifetime: reasoning streams, so the gap
 * between the first token and the last is the time spent thinking. A think
 * that arrived in one piece has no measurable span, and says nothing rather
 * than claiming "0s".
 */
export function Thought({
  message,
  vocabulary,
}: {
  message: MessageEntity
  vocabulary: InlineVocabulary
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const seconds = Math.round((message.updatedAt - message.createdAt) / 1000)
  const label = message.streaming ? "Thinking" : seconds > 0 ? `Thought for ${seconds}s` : "Thought"

  return (
    <li className={`step is-thought${open ? " is-expanded" : ""}`}>
      <button type="button" className="step-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="step-icon-slot">
          <CircleDashedIcon size={14} className="step-icon" aria-hidden="true" />
          <ChevronDownIcon size={14} className="step-chevron" aria-hidden="true" />
        </span>
        <span className="step-title">{label}</span>
        {message.streaming && <span className="pulse-dot" aria-label="still thinking" />}
      </button>
      {open && (
        <div className="thought-body">
          <ChatMarkdown text={message.text} vocabulary={vocabulary} streaming={message.streaming} />
        </div>
      )}
    </li>
  )
}

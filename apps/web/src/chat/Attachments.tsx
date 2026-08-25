import { useState } from "react"
import type { MessageAttachment } from "@observer-ai/protocol"
import { attachmentUrl } from "../api"

/**
 * The files a human handed to an agent, shown inside the turn that carried
 * them.
 *
 * A screenshot is usually the *whole* question — "why does this look like
 * that?" means nothing without the image — so a transcript that silently drops
 * it is missing the message, not a decoration. Images render inline; anything
 * else is named rather than guessed at, because Observer cannot preview a PDF
 * and should not pretend the file was unimportant either.
 *
 * Nothing here is cached by Observer. The bytes stay where the host put them
 * and the daemon reads them on demand, which is also why a file the host has
 * since cleaned up degrades to its name instead of a broken image icon.
 */
export function Attachments({ attachments }: { attachments: MessageAttachment[] }): JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <ul className="attachments">
      {attachments.map((attachment) => (
        <Attachment key={attachment.id} attachment={attachment} />
      ))}
    </ul>
  )
}

function isImage(attachment: MessageAttachment): boolean {
  // The daemon refuses to serve an SVG as an image, so do not ask it to.
  if (attachment.mimeType === "image/svg+xml") return false
  if (attachment.mimeType) return attachment.mimeType.startsWith("image/")
  return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(attachment.path ?? attachment.name)
}

function Attachment({ attachment }: { attachment: MessageAttachment }): JSX.Element {
  const [failed, setFailed] = useState(false)
  const url = attachmentUrl(attachment.id)
  const title = attachment.path ?? attachment.name

  if (!isImage(attachment) || failed) {
    return (
      <li className="attachment attachment-file">
        <a href={url} target="_blank" rel="noreferrer" title={title}>
          {attachment.name}
        </a>
        {failed && <span className="muted small"> — bytes no longer on disk</span>}
      </li>
    )
  }

  return (
    <li className="attachment attachment-image">
      <a href={url} target="_blank" rel="noreferrer" title={title}>
        <img src={url} alt={attachment.name} loading="lazy" onError={() => setFailed(true)} />
      </a>
      <span className="attachment-name">{attachment.name}</span>
    </li>
  )
}

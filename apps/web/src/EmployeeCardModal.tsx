import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import type { CSSProperties, RefObject, SyntheticEvent } from "react"
import type { RosterProfile } from "@observer-ai/roster"
import { useDismissLayer } from "./dismissLayer"
import {
  CARD_LAYOUT,
  PHOTO_BACKDROP_FALLBACK,
  PHOTO_BACKDROP_STOPS,
  cardCssVariables,
  employeeCardContent,
  photoBackdropGradient,
  scaledFontSize,
} from "./employeeCard"

export interface EmployeeCardModalProps {
  profile: RosterProfile
  onClose: () => void
  /** The node that opened the card, so focus goes back where it came from. */
  returnFocus?: () => HTMLElement | null | undefined
}

/**
 * The NJ-LABS employee ID card, full-bleed over the canvas.
 *
 * This is a reproduction of a printed artifact, not interface chrome, which
 * is why it carries rounded corners, purple gradients and Inter — all three
 * banned everywhere else by `docs/adr/0002-pixel-art-interface.md`. See
 * `docs/adr/0003-employee-card-carve-out.md` for the scope of the exception.
 * Nothing in here styles anything outside `.nj-card`.
 *
 * The template PNG is 1.6MB, so it is referenced from this component and
 * nowhere else: mounting the modal is the only thing that fetches it.
 */
export function EmployeeCardModal({ profile, onClose, returnFocus }: EmployeeCardModalProps): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useDismissLayer(onClose, { focusRef: closeRef, returnFocus })
  useFocusTrap(cardRef)

  const content = useMemo(() => employeeCardContent(profile), [profile])
  const style = useMemo(() => cardCssVariables() as CSSProperties, [])
  const [backdrop, setBackdrop] = useState(PHOTO_BACKDROP_FALLBACK)
  const [photoBroken, setPhotoBroken] = useState(false)

  const onPhotoLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    setBackdrop(samplePhotoBackdrop(event.currentTarget))
  }, [])

  return (
    <div
      className="nj-overlay"
      // Pointer-down, not click: a drag that starts on the card and ends on
      // the backdrop is a text selection, not a dismissal.
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={cardRef}
        className="nj-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        style={style}
      >
        {/* Every word on the template is reproduced in the description list
            below, so the artwork itself is decorative. */}
        <img className="nj-card-template" src={CARD_LAYOUT.templateUrl} alt="" aria-hidden="true" draggable={false} />

        <div className="nj-photo-frame" aria-hidden="true" style={{ background: backdrop }}>
          {!photoBroken && (
            <img
              className="nj-photo-img"
              src={profile.imageUrl}
              alt=""
              width={CARD_LAYOUT.portrait.width}
              height={CARD_LAYOUT.portrait.height}
              draggable={false}
              decoding="async"
              onLoad={onPhotoLoad}
              onError={() => setPhotoBroken(true)}
            />
          )}
        </div>

        <div className="nj-name" aria-hidden="true" style={{ fontSize: scaledFontSize(content.nameFontSize) }}>
          {content.nameLines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>

        {content.fields.map((field) => (
          <div
            key={field.row}
            className={`nj-pill nj-pill-${field.row}`}
            aria-hidden="true"
            style={{ fontSize: scaledFontSize(field.fontSize) }}
          >
            {field.value}
          </div>
        ))}

        <h2 id={titleId} className="nj-sr-only">
          NJ-LABS employee card — {profile.fullName}
        </h2>
        <dl id={descriptionId} className="nj-sr-only">
          {content.fields.map((field) => (
            <div key={field.row}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>

        <button ref={closeRef} className="nj-close" onClick={onClose} aria-label="Close employee card">
          ✕
        </button>
      </div>
    </div>
  )
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Keeps Tab inside the dialog.
 *
 * The card holds exactly one control today, so this mostly stops Tab from
 * walking off into the canvas behind a modal the developer cannot see past.
 */
function useFocusTrap(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const container = ref.current
    if (!container) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return
      const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      )
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) {
        event.preventDefault()
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    container.addEventListener("keydown", onKeyDown)
    return () => container.removeEventListener("keydown", onKeyDown)
  }, [ref])
}

/**
 * Samples the portrait's top edge into the gradient that fills the gap a
 * bottom-pinned portrait leaves above itself.
 *
 * Same-origin in Observer, so the canvas does not taint — but the reference
 * ran from `file://` where it does, and the fallback is cheap enough to keep.
 */
function samplePhotoBackdrop(image: HTMLImageElement): string {
  try {
    const probe = document.createElement("canvas")
    probe.width = PHOTO_BACKDROP_STOPS
    probe.height = 1
    const context = probe.getContext("2d", { willReadFrequently: true })
    if (!context) return PHOTO_BACKDROP_FALLBACK
    // Average the top 2% of the portrait down to one row of samples.
    const band = Math.max(1, Math.round(image.naturalHeight * 0.02))
    context.drawImage(image, 0, 0, image.naturalWidth, band, 0, 0, PHOTO_BACKDROP_STOPS, 1)
    return photoBackdropGradient(context.getImageData(0, 0, PHOTO_BACKDROP_STOPS, 1).data)
  } catch {
    return PHOTO_BACKDROP_FALLBACK
  }
}

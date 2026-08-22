# The employee card is an artifact, not interface

ADR 0002 draws two hard lines through the interface: every `border-radius` goes to zero, and no raw
colour literal exists outside `:root`. Both are load-bearing. A round corner in a pixel interface
reads as a rendering fault, and a palette stops being a constrained ramp the moment anyone can add
to it locally.

The NJ-LABS employee ID card breaks both. It has 44px corners, a purple-to-navy gradient printed
into its artwork, a 14px-rounded portrait window, and it is set in Inter Black. Double-clicking an
agent node now opens it over the canvas.

**This is a real exception, not a reading of the rules that lets it through.** There is no
interpretation of "every `border-radius` goes to zero" under which a card with rounded corners
complies. What is true instead is that ADR 0002 was written about the interface, and the card is
not interface.

## Where the line actually falls

The card is a reproduction of a printed object. Its artwork is a single 1023x1537 raster,
`apps/web/public/card/emploee-card.png`, and every visual decision in it — the corners, the
gradient, the purple pill shapes, the ROLE / DEPARTMENT / EMPLOYEE ID / ACCESS LEVEL captions — was
made by whoever drew that PNG. The four `div`s and one `<img>` Observer contributes place text and a
portrait into holes already cut in the artwork. They do not style anything; they fill something in.

So the rules are scoped rather than bent. ADR 0002 governs chrome: the things Observer designs.
It does not get to redesign a photograph of a thing, any more than it gets to restyle a screenshot
a developer pastes into a chat panel. The alternative — a pixel-art reinterpretation of the card,
square corners and cyan neon — would be a different object with the same data on it, which is not
what was asked for and would make the 1.6MB template pointless.

The boundary is a selector list, and it is checkable. Everything the carve-out covers lives under
`.nj-overlay` in `apps/web/src/styles.css`, in a block that says so. The card's colours are declared
on `.nj-overlay` as a second token block, not added to `:root`, so `--nj-photo-edge` is unreachable
from any interface rule and the artifact's purple can never leak into the state ramp. The docked
Worker card panel is untouched and stays pixel-art; the modal's own close button stays square,
because that button is chrome.

## What did not get carved out

**Accessibility.** The card is a modal and behaves like one: `role="dialog"`, `aria-modal`, a focus
trap, Escape to close, and focus returned to the node it was opened from. Every value the artwork
sets in type is also emitted as real text in a visually-hidden `<dl>`, so the card is readable
without being seen — which is what lets the visible pill type stay as small as a printed ID card's.

Escape needed fixing first. The Worker card and the activity panel each bound their own global
`keydown` listener and each called `focus()` on mount, and they always mount together, so one
keystroke fired both handlers and whichever effect ran last silently won the focus. Adding a third
listener on top would have closed the modal and both panels underneath it in a single press.
Dismissal is now a stack (`apps/web/src/dismissLayer.ts`): layers register in mount order and only
the top one hears Escape.

**Motion.** `prefers-reduced-motion` kills the overlay's fade, both through the global block in
`styles.css` and by name.

**Fonts.** `docs/privacy.md` still forbids a CDN, so Inter is vendored as woff2 next to JetBrains
Mono and Silkscreen under `apps/web/public/fonts/`, with its OFL text. It is deliberately *not*
preloaded in `index.html`: no interface surface uses it, so it should cost nothing until a card
opens. The reference implementation asked for `Inter` without shipping it, which meant most machines
drew a browser-synthesised fake bold at the card's largest type — the one place a faux weight is
least survivable.

**Payload.** The 1.6MB template is referenced from `EmployeeCardModal.tsx` and nowhere else, so
mounting the modal is the only thing that fetches it.

## Consequences

The layout is a typed constant in template-pixel space, `CARD_LAYOUT` in
`apps/web/src/employeeCard.ts`, and it divides through to CSS custom properties exactly once. The
reference held the same numbers in three places — `PHOTO_ZOOM` in `app.js`, the equivalent
percentages in `.photo-img`, and a second set of rects in the canvas exporter — and they had drifted:
pill text exported ~32% smaller than it previewed, letter-spacing vanished, and the two auto-shrink
paths measured different strings against different thresholds. `styles.css` now reads variables and
restates no geometry.

Re-measuring the template raster rather than inheriting the reference's numbers moved two pill rows.
Sampling the PNG's own luminance step at five x positions puts the EMPLOYEE ID and ACCESS LEVEL row
centres at 939 and 1057; both reference renderers had them at 935 and 1052, riding 4-5px high. Rows
1 and 2 measured exactly where the reference said they were, which is what says the method is sound
rather than off by a constant.

Employee numbers moved off the array index. The reference computed `10415 + arrayIndex`, so
inserting anyone above the last entry reissued everybody else's ID. They are now pinned to
`profile.id`, seeded with the numbers that arithmetic produced for the roster as it stands, with a
hashed fallback in a disjoint band for ids that are not pinned. Nobody's card changes today and
nobody's card changes when the roster is reordered.

Department, employee ID and access level stay derived. None of them exists on `RosterProfile`, and
none should: a department is a view of a title, and adding one to `packages/roster` would put two
sources of truth in the repo for a fact only this card renders.

Rejected: rendering the card in JetBrains Mono to avoid vendoring a fourth typeface. The template's
own captions are set in a proportional sans, so a monospace overlay would read as a rendering bug
rather than a decision — and monospace advances are wide enough that half the roster's titles would
have needed cutting to fit a 267px pill.

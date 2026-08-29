# Observer mobile UI recommendation

**Prepared by:** Sofia Moreno, Lead Product Designer  
**Scope:** design/prototype guidance only; no product code, tests, or configuration changed.  
**Surface:** `apps/web` live Observer canvas, session list, agent detail panel, settings page, and NJ-LABS employee card.

## Executive recommendation

Treat mobile as a focused **watch-and-inspect mode**, not a compressed desktop. Observer's job is live watching (ADR 0001), and the canvas must remain the primary stage. On phones, make one surface primary at a time:

1. **Canvas first:** full-width, pannable/zoomable graph with a compact top status bar.
2. **Sessions as a discoverable sheet:** the current responsive sidebar becomes a short, draggable-looking (but keyboard-safe) top sheet/strip; selecting a session closes it.
3. **Agent detail as a bottom sheet:** a selected agent opens a sheet with Chat default and Profile/Prompt/Todos as disclosures or tabs. It must never create a second scroll axis for prose.
4. **Settings as a page with a single-column contents list:** the desktop rail becomes a top “Settings section” selector; preserve URL hash/deep links and browser Back.

This is the smallest correct scope: responsive layout and interaction changes around existing surfaces, without changing the protocol, event model, terminology, or canvas semantics. Keep the existing pixel-art/T3 token system, vendored JetBrains Mono, Lucide icons, focus ring, and reduced-motion behavior. Do not introduce a social-media visual skin; borrow proven *information architecture* patterns only.

## Incumbent UI facts and constraints

- `App.tsx` currently composes topbar → `SessionSidebar` + canvas → lazy `DetailPanel`; settings are a URL-hash page; `EmployeeCardModal` is a separate modal layer.
- Desktop widths are 240px sidebar and 420px panel; below 900px the sidebar stacks at the top and the panel becomes a 72vh bottom sheet. This is a good direction, but it currently leaves too much desktop chrome and does not define 280–412px behavior.
- `DetailPanel` already has a single-agent mental model (ADR 0004), Chat/Prompt/Todos content, an interleaved tool timeline, and scroll-pinning behavior. Preserve these.
- `index.html` already permits zoom (`width=device-width, initial-scale=1.0, viewport-fit=cover`). `index.css` already centralizes tokens, focus-visible, and `prefers-reduced-motion`.
- Existing controls include visual sizes around 28px and 30px; these are acceptable desktop compact controls but too small as isolated touch targets. Enlarge hit areas without necessarily enlarging visual glyphs.
- Canvas graph is a meaningful two-dimensional exception under WCAG reflow; transcript/settings prose are not. Keep horizontal overflow confined to code/graph regions.

## Prototype model (state and priority)

```text
PHONE
┌─────────────────────────────────────┐
│ Observer   [live]     [sessions] [⚙]│  sticky, safe-area top
├─────────────────────────────────────┤
│ session chip / “3 active” (optional)│  one-line horizontal strip
│                                     │
│          CANVAS / graph              │  pan + pinch; no page x-scroll
│                         [fit] [zoom] │
├─────────────────────────────────────┤
│ selected agent sheet (0–72dvh)       │  only when selected
│ Sofia · running       [close]         │
│ Profile Chat Prompt Todos             │
│ transcript / tool disclosure          │
└─────────────────────────────────────┘
```

### Mobile state transitions

- **Session picker closed → open:** tap `Sessions` (or current session chip). Open a modal-like sheet with search only if sessions exceed roughly 8; otherwise a dense list. Escape, backdrop tap, close button, and browser Back close the sheet in that order before leaving the route.
- **Agent selected:** open detail sheet; keep selected graph node visible where possible, but do not auto-pan on a normal click. Sheet height starts around 56dvh, expands to ~90dvh on an explicit “expand” affordance, and can collapse to a compact summary. A drag gesture is optional enhancement; never make drag the only route to collapse/expand.
- **Agent sheet + employee card:** employee card remains the topmost modal layer. Its close returns focus to the ID-card trigger; closing the sheet returns focus to the canvas node.
- **Settings:** opening settings replaces the app route visually, keeps `#settings/<tab>`, and pushes history. Back returns to the canvas. A mobile section selector replaces the rail; content is one scroll container.

## Navigation and action placement

### Primary navigation

- Do not add a social-style five-item bottom nav: Observer has one live work surface and settings, not five peer destinations. A bottom nav would permanently consume canvas height and compete with the detail sheet.
- Use a compact sticky topbar: brand/status, current session switcher, settings. Keep the existing connection state text; do not rely on a colored dot alone.
- Session list should be a sheet/overlay rather than a 30vh block that permanently steals graph height. It may show current session and active-agent count in a 44–52px chip row when closed.
- On landscape phones, allow the session list to become a left rail only when `min-width`/available inline size safely supports it; otherwise retain overlay behavior.

### Actions

- Place **FIT** and zoom controls in the graph's lower trailing corner, offset by safe-area inset and at least 8px from one another. Keep `1:1`; consider moving it into an overflow menu if the HUD cannot fit at 280px.
- Keep destructive “Delete session” inside the session sheet, below the session's agent list and separated from navigation. Require confirmation for deletion if not already present.
- On a selected agent sheet, place close at top trailing, identity/status at top leading, and tabs below. Do not put frequent transcript actions in a floating corner.
- Use “More” overflow for low-frequency details (full model identifier, provenance notes, host capability notes), not for core Chat/Profile access.

## Dense lists, feeds, and disclosure

- Session rows: one-line title with ellipsis + second-line host/time/count. Make the whole row a single target; keep delete and expand as separate targets with 8px clearance.
- Agent mini-list: use 44px row height on touch, 20–24px portrait, status text for screen readers, and a visible selected treatment. Avoid nesting a tiny disclosure button inside a tiny clickable row.
- Transcript: preserve chronological narrative and auto-scroll only when pinned. When new content arrives while the reader is away from the bottom, show a non-obscuring “New activity” affordance that jumps to the latest; never yank the reader.
- Tool runs: retain the current summary-row disclosure. On mobile, default long runs collapsed and expose count/action (“Read 12 files”) before details. Use native `<details>` semantics where possible, or `aria-expanded` + `aria-controls` with a real button.
- Prompt and Todo long content: wrap identifiers with `overflow-wrap:anywhere`; keep code/pre blocks in a local scroll container with an accessible label and visible scroll affordance. Do not let the page itself become two-dimensional.
- Truncation is acceptable only when the full value is available through activation or an accessible name/description. Never truncate an error message without a “Show details” path.

## Touch targets and safe areas

- Use **44px minimum visual target** as the product baseline for primary touch controls (consistent with common iOS guidance), and at least WCAG 2.2 SC 2.5.8's 24×24 CSS px minimum with spacing exceptions. Existing 28px `.icon-button`, 34px session-rail item, and 30px mini-agent rows need larger hit boxes on mobile.
- Keep at least 8px between adjacent controls. The target can be larger than its icon via padding/pseudo-element, but avoid overlapping neighboring actions.
- Add `padding-inline: max(12px, env(safe-area-inset-left/right))` to fixed/sticky chrome and `padding-bottom: calc(12px + env(safe-area-inset-bottom))` to bottom sheets/HUDs. Use `dvh`/`svh` rather than assuming `100vh` equals the visible viewport.
- Ensure bottom-sheet content has `scroll-padding-block: 16px` plus safe-area padding so focused controls are not hidden behind the home indicator or sheet header.
- `touch-action: manipulation` is appropriate for ordinary buttons; preserve pan/pinch gestures on the graph and do not globally disable browser gestures.

## Typography and visual hierarchy

- Preserve JetBrains Mono for developer-readable names, transcripts, tool output, prompts, and model IDs; preserve Silkscreen/micro-label convention if already present in the incumbent system. Do not shrink body text to fit: target 16px-equivalent readable prose on mobile, with 1.45–1.6 line height.
- Use `clamp()` only for display/landing headings. For app chrome, prefer stable 12–14px labels and 16px body, allowing wrapping at 280px.
- Keep state colors as secondary carriers: status text (“running”, “failed”, “completed”) and icons/shape must communicate without color. Verify all theme palettes at 4.5:1 for normal text and 3:1 for large text/non-text boundaries.
- Reduce topbar goal to one line with an explicit “Show goal” disclosure on narrow widths; never squeeze filter controls, host, status, and settings into one row.

## Modals, overlays, and focus

- Treat session picker and detail panel as modal sheets only on narrow widths; provide `role="dialog"`, `aria-modal="true"`, labelled heading, focus entry, focus trap, Escape, backdrop dismissal where safe, and return focus.
- Preserve existing `useDismissLayer` stacking: employee card > detail sheet > session picker/page. Only the top layer handles Escape.
- Backdrop tap should dismiss only the current sheet, not delete, navigate away, or close an unrelated layer. Do not dismiss when pointer starts inside the panel and ends outside.
- Avoid full-screen dialogs for short choices. Use a sheet for lists; use a centered modal only for destructive confirmation or the NJ-LABS artifact.
- Focus indicators remain 2px visible outlines with enough contrast and offset. Test keyboard order even though the target is mobile: external keyboards and switch access matter.

## Keyboard and forms

- Settings search: retain `/` shortcut on desktop, but never hijack `/` while typing. On mobile use an explicit search field with visible label, `type="search"`, and a 44px row/control.
- Add suitable `inputmode`/`autocomplete` to provider IDs, ports, URLs, and tokens. Use `type="url"` for endpoint fields and keep labels persistent above fields; placeholders are examples, not labels.
- When the virtual keyboard opens, anchor sheets to the visual viewport (or account for `keyboard-inset-*` where supported), keep the active field visible, and avoid fixed controls covering the submit action.
- Inline validation belongs beside the field, with `aria-describedby` and an error summary only when multiple fields fail. Preserve drafts and commit semantics already established by `DraftInput`.

## Portrait, landscape, and width matrix

| Viewport | Recommended composition | Key acceptance checks |
|---|---|---|
| 280 stress | Brand + status + icon actions only; current session chip; canvas; sheet full width | No horizontal page scroll; no clipped close/action; labels wrap or disclose; graph controls collapse to overflow |
| 320 | Same as 280, with 8px outer gutter | WCAG reflow baseline for prose; transcript/tool rows wrap; code scroll is local |
| 360 | 12px gutters; session chip may show title + count | 44px targets; tabs fit or scroll with active tab kept visible |
| 375 | Baseline portrait | Verify sheet header + first transcript row; keyboard does not hide composer/settings field |
| 390 | Baseline portrait | Long employee names, model IDs, and host labels do not force x-overflow |
| 412 | Optional two-control graph HUD | Goal/status can show one extra fact; never restore full desktop chrome automatically |
| Landscape phone | Prefer graph-first; sheet can be 80–90dvh or side panel if width allows | Do not lock orientation; preserve pan/pinch and safe left/right insets |

Suggested layout thresholds are **content-based**, not device-name-based: base mobile, `@media (min-width: 600px)` for compact tablet/landscape options, `@media (min-width: 900px)` for current desktop layout, and `@media (min-width: 1200px)` for docked detail panel behavior. Validate every listed width and browser zoom to 200%.

## Zoom, accessibility, and reduced motion

- Keep the viewport meta's zoom allowance. Do not use `user-scalable=no`, `maximum-scale=1`, or transform-based text scaling.
- WCAG 2.2 SC 1.4.10 requires non-exempt content to reflow at 320px; SC 1.4.4 requires text to remain usable at 200%. The graph itself can remain pannable/two-dimensional because spatial relationships are its meaning, but all surrounding prose and controls must reflow.
- Preserve React Flow's continuous 0.25–3x graph zoom and keyboard/HUD access. Make pinch zoom graph-local; do not intercept pinch on sheets or prose.
- Keep the existing reduced-motion CSS and JavaScript handling. Disable infinite pulses, packet/edge flair, panel slide, and model auto-rotate under `prefers-reduced-motion: reduce`; replace state motion with static contrast/labels. W3C notes interaction-triggered motion should be disable-able; the existing implementation is close—verify every newly introduced sheet transition.
- Include a “New activity” live-region update without constant announcements for every token. Announce meaningful state changes (agent failed, completed, new session), not stream noise.
- Respect forced colors/high contrast and keyboard focus. Use Lucide SVG icons with labels; no emoji as control icons.

## Social-product patterns: transferable, not copied

Social products are useful as pattern references because they solve high-frequency, dense, thumb-driven navigation. Borrow the behavior, not the branding/assets:

- **Instagram mobile navigation** (public product surface, [Instagram announcements](https://about.instagram.com/blog/announcements/instagram-navigation-update), URL checked 2026-08-29; page may require JS): bottom navigation keeps frequent destinations stable and makes creation/action placement predictable. Transferable lesson: frequent destinations need stable, thumb-reachable placement. For Observer, this argues for a stable session switcher and a single primary canvas—not a five-item clone.
- **Pinterest-style feed/list patterns** (public product/design discussions; the specific engineering URL previously tested returned 404): dense cards use strong scan hierarchy, progressive disclosure, and local actions. Transferable lesson: expose identity/status first, move secondary metadata behind a disclosure, and keep each card's primary target coherent. For Observer, use this in session rows and collapsed tool runs, not masonry imagery.
- **YouTube mobile navigation/player patterns** (public product surface; a candidate blog URL returned 404): persistent player/miniplayer patterns preserve context while browsing. Transferable lesson: preserve the live context while opening secondary surfaces. For Observer, keep the canvas context visible behind a sheet and avoid replacing it with a route that loses selection.
- **X/Twitter-like timeline patterns** (public product surface): chronological feeds use compact author/time metadata, grouped content, and explicit “new posts” affordances when reading away from the live edge. Transferable lesson: Observer's current pinned transcript + non-yanking “New activity” pattern is the correct analogue.

These product URLs are inspiration records, not normative standards. Normative/technical guidance used here is W3C WCAG 2.2, MDN `env()`, MDN responsive CSS guidance, and Chrome's responsive viewport documentation.

## Smallest implementation direction for Arjun

1. Introduce a mobile mode around existing `App`, `SessionSidebar`, `DetailPanel`, and settings page; do not alter store/protocol behavior.
2. At narrow inline sizes, render the sidebar as a controlled session sheet/compact chip rather than a permanently 30vh block.
3. Keep the detail panel as one sheet with existing tabs/timeline; add explicit collapsed/expanded states if needed, not a second panel.
4. Increase mobile hit-area boxes to 44px and apply safe-area/dvh padding to fixed layers/HUDs.
5. Add layout/overflow acceptance tests or manual QA—not code changes in this design artifact—for 280, 320, 360, 375, 390, 412 portrait and at least one landscape width, plus 200% zoom and reduced motion.

## Open questions before implementation

- Is the intended phone audience primarily monitoring from a desktop-adjacent browser (wide landscape) or genuinely one-handed portrait use? This determines whether the session picker should default to a top sheet or a bottom sheet.
- Should “Delete session” remain available on mobile, and if so, is confirmation product-approved? It is high-risk to leave as a low-friction row action.
- Is a collapsed detail-sheet state valuable for watching the graph while retaining selection, or does a close/reopen affordance suffice for v1?
- Are provider/token settings expected to be completed on phone, or merely inspected? If completed, keyboard-inset behavior deserves its own focused prototype.

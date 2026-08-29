# Observer mobile-responsive design direction

**Designer:** Sofia Moreno, Lead Product Designer
**Boundary:** design artifact only. No product code, tests, or configuration were modified.

## Process confirmation

- Explicitly loaded and applied both required skills: `impeccable` and `ui-ux-pro-max`.
- Ran Impeccable context against `apps/web/src/App.tsx` from `apps/web`; it identified an incumbent visual implementation and missing `PRODUCT.md`/`DESIGN.md`, so existing code, tokens, assets, and ADRs were treated as visual authority.
- Inspected repository guidance (`AGENTS.md`, `CONTEXT.md`, `docs/agents/domain.md`), relevant ADRs (`0001-live-watching-over-forensics`, `0002-pixel-art-interface`, `0004-one-agent-one-panel`), and actual web surfaces: `App`, `SessionSidebar`, `Canvas`, `DetailPanel`, settings, `EmployeeCardModal`, primitives, and responsive CSS.
- UI Pro Max searches covered mobile navigation/touch, disclosure/modal/focus/reduced motion, responsive layout, and a mobile Observer design-system direction. Its canvas-specific web query returned no match; canvas guidance below is explicitly a general fallback plus repository evidence.

## Recommendation: watch-and-inspect, not compressed desktop

Observer's product truth is live watching. Keep the canvas primary and make one secondary surface primary at a time on phones:

1. **Canvas first:** full-width pannable/zoomable graph with compact status chrome.
2. **Sessions:** closed compact current-session chip/row; tap opens a modal sheet/list. Do not permanently consume 30vh with a stacked sidebar.
3. **Agent detail:** selected agent opens one bottom sheet, Chat remains default, and Profile/Prompt/Todos remain available. Do not reintroduce a second agent panel.
4. **Settings:** preserve `#settings/<tab>` and browser Back; replace the desktop rail with a top section selector and one scrolling column.

This is the smallest correct scope: responsive composition, hit areas, safe-area handling, and overflow behavior around existing surfaces. Do not alter protocol/store semantics, domain vocabulary, event timeline, or the existing pixel/T3 token system, vendored JetBrains Mono, Lucide icons, focus ring, and reduced-motion contracts.

## Tailored surface direction

### App/topbar

At narrow widths, retain Observer + connection state + sessions + settings. Collapse the goal to an ellipsis/disclosure (“Show goal”) instead of squeezing goal, filters, host, status, and settings into one line. Use explicit text for connection/status; color and dots are secondary carriers.

### Sessions (`SessionSidebar`)

Use a single coherent target per session row: title (ellipsis), host/time/count metadata, and a clearly separated agent-list disclosure. Keep delete below the row/list, separated from navigation, and require confirmation if product policy permits. Existing 34px rail items and 30px agent-mini rows need mobile hit-area enlargement to at least 44px, with 8px adjacent spacing. For many sessions (roughly >8), add search; otherwise avoid adding search chrome.

### Canvas (`Canvas`/React Flow)

Keep the graph two-dimensional because spatial relationships are its meaning. Preserve continuous 0.25–3x zoom, FIT, 1:1, keyboard/HUD access, and local pinch/pan. Do not intercept pinch or horizontal gestures on sheets/prose. At 280px, reduce the HUD to essential controls and move FIT/1:1 into overflow if necessary; do not allow page-level horizontal scrolling. Offset HUD controls from edges and safe areas.

### Agent detail (`DetailPanel`)

On phones, bottom sheet starts around 56dvh and can explicitly expand toward 90dvh; a compact selected-agent summary can preserve graph context. Drag may enhance but must not be the only collapse/expand path. Keep identity/status in the top leading region, close/expand in top trailing region, tabs below, Chat default, and current chronological timeline. When the reader is not pinned to the bottom, show non-yanking “New activity”; never auto-scroll them away from reading.

Keep long contiguous tool runs collapsed with an action/count summary (for example, “Read 12 files”), then disclose details using real button + `aria-expanded`/`aria-controls` or native `<details>`. Keep code/pre in a local scroll container. Wrap URLs, model IDs, and other long tokens with `overflow-wrap:anywhere`; never let transcript prose create page-level x-overflow.

### Settings

Keep settings a page, not a modal. On mobile, a 44px “Settings section” selector replaces the 240px rail. Preserve hash deep links, focus behavior, `/` search shortcut only when not typing, visible labels, and a single vertical scroll container. Settings controls should reflow at 320px and continue to work at 200% text zoom.

### Employee card (`EmployeeCardModal`)

Keep the NJ-LABS card as the topmost artifact modal and preserve its intentional visual carve-out. Maintain focus trap, Escape, backdrop rules, and return focus to the opening node/ID-card trigger. Use safe-area-aware overlay padding; if the card reaches its minimum 280px width, scroll the overlay rather than shrinking artwork into unreadability.

## Navigation, overlays, and actions

- Do **not** add a five-item social-style bottom nav: Observer has one primary work surface and settings, so permanent bottom navigation would consume canvas height and conflict with the detail sheet.
- Use stable top chrome for sessions/settings. Session sheet opens/closes with explicit control, Escape, backdrop tap, and browser Back; Back closes the top sheet before leaving the page.
- Layer order is employee card > detail sheet > session sheet/page. Only the top layer handles Escape.
- Sheets need labelled `role="dialog"`/`aria-modal="true"` where modal, focus entry/trap/return, visible close, and a non-destructive backdrop dismissal. Never dismiss an action such as delete via accidental backdrop tap.
- Put frequent graph actions near the lower trailing edge; put low-frequency provenance/model details behind “More”. Keep destructive actions away from primary row navigation.

## Touch, safe areas, forms, and typography

- Use 44px as the product baseline for primary mobile targets; WCAG 2.2 SC 2.5.8 requires at least 24×24 CSS px or adequate spacing. Keep 8px between neighboring targets. Increase hit boxes without inflating glyphs where density matters.
- Fixed chrome and sheets should account for `env(safe-area-inset-top/right/bottom/left)`; bottom padding should include `env(safe-area-inset-bottom)`. Prefer `dvh`/`svh` over assumptions based on `100vh`. Keep focused elements inside `scroll-padding` and safe-area padding.
- Preserve browser zoom; never use `user-scalable=no` or `maximum-scale=1`. Text/prose must reflow at 320px and survive 200% text resizing. Graph/code are local meaningful exceptions, not permission for page-wide two-axis overflow.
- Preserve JetBrains Mono for developer-readable content. Do not shrink body copy to fit; target roughly 16px-equivalent mobile prose and 1.45–1.6 line-height. Verify every theme's text and non-text boundaries at required contrast.
- For provider IDs, ports, URLs, and tokens use visible labels plus suitable `inputmode`, `type="url"`, and `autocomplete`. Keep the active field visible above the virtual keyboard; preserve existing draft/commit semantics.

## Motion and accessibility

- Retain the existing CSS and JavaScript `prefers-reduced-motion` handling. Newly added sheets must not rely on slide motion for comprehension; disable panel transitions, pulses, packet/edge flair, and model auto-rotate under reduced motion, replacing them with static state styling and text.
- Announce meaningful changes (agent failed/completed, new session, “New activity”), not every streamed token. Keep focus rings visible for keyboard, switch access, and external keyboards.
- Use labelled Lucide SVG controls, never emoji icons. Avoid hover-only affordances. Keep status meaning in text/shape as well as color.

## Width/orientation acceptance matrix

| Viewport | Composition | Acceptance checks |
|---|---|---|
| 280 stress | Brand/status/icons; session chip; canvas; full-width detail sheet | No page x-scroll; no clipped close/action; HUD essentials only; labels wrap/disclose |
| 320 | Same with 8px outer gutter | WCAG reflow baseline; transcript/tool rows wrap; only code/graph may scroll horizontally |
| 360 | 12px gutters; title + count chip | 44px targets; tabs scroll if needed and keep active tab visible |
| 375 | Baseline portrait | Sheet header and first transcript row visible; keyboard does not cover active field/action |
| 390 | Baseline portrait | Long names, host labels, model IDs, URLs wrap/disclose without x-overflow |
| 412 | Optional second graph HUD control | Goal/status may expose one extra fact; do not restore desktop chrome prematurely |
| Landscape phone | Graph first; sheet 80–90dvh or side panel only if width supports it | No orientation lock; preserve pan/pinch and left/right safe insets |

Use content-based breakpoints rather than device-name assumptions: base mobile, around 600px for compact tablet/landscape adaptations, 900px for current desktop composition, and 1200px for docked detail behavior. Validate portrait and landscape, browser zoom to 200%, keyboard open, forced colors, and reduced motion.

## Public sources and transferable rationale

Social products were used as inspiration for behavior, not brand assets or styling:

- Instagram navigation announcement (URL checked; page may require JavaScript): https://about.instagram.com/blog/announcements/instagram-navigation-update — stable thumb-reachable destinations make frequent navigation predictable. Transfer: a stable session switcher, not a cloned five-item nav.
- Pinterest Engineering candidate (URL checked and returned 404): https://medium.com/pinterest-engineering/pinterest-mobile-design-system-7d4f0a1f8e0a — not treated as verified evidence. Transferable category lesson only: dense cards need scan hierarchy, coherent primary targets, and progressive disclosure.
- YouTube mobile blog candidate (URL checked and returned 404): https://blog.youtube/inside-youtube/innovating-the-youtube-app/ — not treated as verified evidence. Transferable category lesson only: preserve live context while browsing secondary content; for Observer, keep graph context behind detail sheets.
- X/timeline-like public product behavior — chronological feed, grouped metadata, and an explicit “new activity” affordance are the relevant transferable patterns; no brand treatment or asset is copied.

Normative/technical sources consulted:

- W3C WCAG 2.2 Target Size (Minimum): https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html — 24×24 CSS px minimum with spacing exceptions; larger targets are a best practice.
- W3C WCAG 2.2 Reflow: https://www.w3.org/WAI/WCAG22/Understanding/reflow.html — non-exempt content must reflow at 320px; keep two-dimensional scrolling local to meaningful graph/code regions.
- W3C WCAG 2.2 Resize Text: https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html — text must remain usable at 200%; do not disable zoom or clip enlarged controls.
- W3C WCAG 2.3.3 Animation from Interactions: https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html — nonessential interaction motion should be disable-able.
- MDN `env()`: https://developer.mozilla.org/en-US/docs/Web/CSS/env — safe-area and keyboard/environment insets with fallbacks.
- MDN `prefers-reduced-motion`: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion — user preference detection and safer replacement motion.
- Chrome for Developers intrinsic sizing: https://developer.chrome.com/docs/css-ui/animate-to-height-auto — progressive enhancement for disclosure transitions; do not make motion a requirement.
- UI/UX Pro Max local guidance/search data: touch targets, 8px spacing, mobile-first, viewport meta, `dvh`, local overflow, keyboard `inputmode`, predictable Back, visible focus, disclosure for truncation, and reduced motion.

## Smallest implementation slice

1. Responsive shell around existing `App`, `SessionSidebar`, `DetailPanel`, and settings; no store/protocol changes.
2. Replace permanent narrow stacked sidebar with controlled session chip/sheet.
3. Keep one agent detail bottom sheet with existing tabs/timeline; add explicit collapsed/expanded states only if useful.
4. Raise mobile hit-area boxes, add safe-area/dvh/keyboard-aware spacing, and constrain overflow to graph/code.
5. QA at all matrix widths/orientations, 200% zoom, keyboard open, forced colors, and reduced motion.

## Decisions to confirm

- Is portrait one-handed use the primary phone context, or is landscape desktop-adjacent monitoring dominant?
- Should mobile session deletion remain available, and is confirmation required?
- Is a collapsed detail-sheet state needed for graph watching, or is close/reopen sufficient for v1?
- Are provider/token settings meant to be completed on phones, or primarily inspected?

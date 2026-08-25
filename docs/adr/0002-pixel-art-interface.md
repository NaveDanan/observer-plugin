# A pixel-art interface, without the game

The interface had drifted into the default generated-dashboard look: a neon-glow logo mark, an
electric-blue-on-near-black palette, pill-shaped badges, soft glows, and React Flow's example chrome
left switched on. Every element was plausible and none was chosen.

We decided to commit to a modern pixel-art idiom, because a deliberate and unusual look is the
opposite of a generic one — and because the alternative fix, picking nicer colours, is itself the
most generic move available.

## The line against looking like a game

The game tell is typography, and the original decision here was to use no bitmap face at all. That
line has moved, narrowly. A blocky display font still reads as "game" the instant you set a
paragraph in it, so no running text uses one. But a pixel interface with no pixel type reads as
half-committed, which pixel art punishes.

The rule is now a split, not a ban:

- **Silkscreen** carries micro-labels only — badges, pill captions, tab labels, section headers,
  the zoom readout. Things that are read as symbols, at a glance, never as sentences.
- **JetBrains Mono** carries everything a developer actually reads: Agent names, tone lines, chat,
  tool output, prompts, model identifiers. It is a monospace built for code, so it holds the grid
  discipline without becoming a bitmap face.

Both are SIL Open Font License, and both are **vendored into the repo**, not linked from a CDN.
`docs/privacy.md` guarantees Observer makes no outbound network calls; a `fonts.googleapis.com`
stylesheet would break that guarantee on every page load and leak the developer's IP and canvas
usage to a third party. The `.woff2` binaries and their OFL text live in `apps/web/public/fonts/`.
JetBrains Mono ships as a single variable file covering the 100–800 weight axis.

## The palette

Pixel art *is* palette discipline; a constrained ramp is what separates it from flat design. The
concrete ramp is cyber-pixel: a near-black ground, flat slate plates, and neon reserved strictly
for state.

| Token | Value | Role |
| --- | --- | --- |
| `--bg-dark` | `#07090e` | canvas ground |
| `--panel-bg` | `rgba(14,18,28,0.96)` | chrome plates |
| `--card-bg` | `#111624` | node and message plates |
| `--card-inner` | `#0b0e17` | recessed wells |
| `--pixel-edge` / `--pixel-highlight` | `#1e263d` / `#2d3859` | the two inset bevel tones |
| `--neon-cyan` | `#00f0ff` | selection, focus, connectors, attachment pins |
| `--neon-emerald` | `#00ff9d` | live — an Agent that is still working |
| `--neon-blue` | `#3b82f6` | the Root agent, and completed work |
| `--neon-red` | `#ff5470` | failed |
| `--neon-amber` | `#ffcc33` | blocked, and delivery faults |

Neon never decorates. If something on screen glows, it is telling you about state.

Depth is structural, not atmospheric: hard `2px`/`3px` black borders, a two-tone `inset` bevel, and
an offset drop shadow with **zero blur** (`3px 3px 0`, `5px 5px 0`, deepening to `7px` on hover).
Blur appears only on neon glows, where it is the glow.

## Contrast is part of the palette, not a review step

Two of the colours the mock proposed do not survive measurement, and the shipped stylesheet does not
use them as proposed:

- `--text-dim` (`#64748b`) reaches only **3.79:1** on `--card-bg`, and 4.18:1 even on the darkest
  ground. It fails AA at body size on every surface in this interface. It is now marked
  decorative-only in `styles.css`; anything a developer must read uses `--text-muted` (`#94a3b8`,
  **7.04:1** on `--card-bg`).
- White on `--neon-blue` for the root badge measures **3.68:1**. The badge inverts to near-black
  text on neon blue instead (**5.41:1**), which also matches how the pixel buttons invert on hover.

Any new colour gets its ratio computed against the surface it actually sits on before it lands.

## Consequences

Pixel art punishes half-commitment — partially-pixel UI reads as broken rather than styled — so this
reaches further than a stylesheet:

- **Zoom must snap to integer steps.** Fractional CSS transform scaling destroys pixel crispness, and
  React Flow's `fitView` always lands on a fraction.
- **Edges become `step`, not `bezier`.** Antialiased curves are the least pixel-art element on screen.
  Edge paths render with `shape-rendering: crispEdges` and a 6/6 dash that flows along the connector.
- **Geometry snaps to a grid.** The canvas ground carries a 28px grid; nodes and ELK's fractional
  layout coordinates round to integers.
- **Every `border-radius` goes to zero.** Enforced in the global reset, not rule by rule. This
  includes the pill badges, the circular status dots, React Flow's default round handles, and the
  Employee's avatar — a round avatar is the single most anti-pixel shape a UI can contain.
- **The palette becomes a constrained ramp**, and every colour in `styles.css` goes through a custom
  property. No raw hex outside `:root` and `@font-face`.
- **Animation steps, it does not ease.** Transitions use `steps()`; the only linear animation is the
  connector dash flow, which is a conveyor and would stutter as steps.
- **Motion is opt-out.** `prefers-reduced-motion: reduce` kills the dash flow, the live pulse and the
  panel slide globally, rather than naming individual selectors that later get renamed away.

## Amended: the employee card is out of scope

Both of the rules above — zero radius, no colour outside `:root` — are broken on purpose by exactly
one surface, the NJ-LABS employee ID card that opens on double-clicking an agent node. That card is
a reproduction of a printed object rather than something Observer designs, so these rules do not
reach it. The exception is real, it is bounded by the `.nj-overlay` selector list in `styles.css`,
and its reasoning is in `0003-employee-card-carve-out.md`. Nothing else in the interface moved: the
docked Worker card panel is unchanged, and the card's own close button is still square.

## Amended: zoom is continuous, not stepped

The stepped-zoom rule above was reversed after use. Five hard stops meant the
wheel fought its operator: a gesture landed between steps and was yanked to
the nearest one on release, and a graph wider than the pane was unreadable at
every allowed level except zoom-out. Zoom is now continuous between 0.25x and
3x across wheel, pinch, HUD buttons and keyboard — bounds, not stops. The
default view holds at exactly 100% instead of fitting, and framing the whole
graph is an explicit FIT action rather than something that happens on load.
Where crispness can still govern, it does: node geometry stays snapped to
integers, and the 1:1 button returns to exact pixels on demand.

## Amended: the graph is a tidy tree, hue is lineage, and one edge curves

Three of the rules above moved once the canvas held real, deeply nested work.

**ELK is gone.** It was only ever run for crossing minimisation, and its
coordinates were thrown away and re-flowed into wrapped rows of five columns.
That wrap is what broke the picture: half a fan-out landed on a second line
that read as a deeper nesting level, so the one thing the canvas exists to
show — who spawned whom — was the one thing it got wrong. `layout.ts` now lays
a tidy tree itself. Every agent at nesting level N shares one y; each sub-tree
owns a horizontal band no sibling enters and its parent is centred over it.
Both invariants are structural, so non-overlap is not something a layout engine
has to be talked into. The tree is wider than the wrapped grid was; that is
what FIT and continuous zoom are for. Layout is now synchronous, which also
removed the four-column grid the canvas used to flash before ELK answered.

**Hue is lineage, not relationship type.** Every edge leaving one agent takes
that agent's own hue, and the notch where an incoming edge lands wears its
spawner's, so tracing a subagent back to its parent is a colour match rather
than a walk up the canvas. A node's *fill* answers a narrower question and
usually declines to: a new node is the plain default card, and only a nested
spawn crew — a subagent that spawned subagents, plus the subagents it spawned —
shares one tinted fill, so a coloured card means "we work together" against a
canvas of ordinary ones. `--app-edge-spawned` and friends survive as the
fallback before the first layout. This is the second deliberate break of "no
colour outside `:root`": the number of branches on a canvas is unbounded and
known only at runtime, so there is no fixed set of tokens to name. `lineage.ts`
generates one OKLCH hue per spawner from a golden-angle step and hands it to CSS
as `--app-lineage` and `--app-lineage-family`.

**One edge stops being a `step`.** A message between two agents that are not
each other's ancestor is the only relationship the tree cannot draw, so it is
the only one drawn with a different geometry: an arc between two side handles,
a diamond at its midpoint and an arrowhead at the recipient, bowing above its
row when it runs left to right and below when it runs right to left. Hierarchy
edges are still orthogonal steps that only ever run downwards, so the two
readings never have to be told apart by colour. A message that *does* run up or
down a bloodline stays a step — the spawn edge beside it already says those two
are related.

Rejected for now: Playwright visual-regression snapshots. They suit pixel art unusually well, since
exact pixel comparison has none of the antialiasing noise that normally makes screenshot tests
flaky — worth revisiting once the look has stabilised, but premature before then.

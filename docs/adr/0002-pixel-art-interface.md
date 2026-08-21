# A pixel-art interface, without the game

The interface had drifted into the default generated-dashboard look: a neon-glow logo mark, an
electric-blue-on-near-black palette, pill-shaped badges, soft glows, and React Flow's example chrome
left switched on. Every element was plausible and none was chosen.

We decided to commit to a modern pixel-art idiom, because a deliberate and unusual look is the
opposite of a generic one — and because the alternative fix, picking nicer colours, is itself the
most generic move available.

## The line against looking like a game

The game tell is typography. A blocky bitmap display font reads as "game" instantly, so we use none:
all running text keeps the ordinary crisp UI font stack. The pixel idiom is expressed only in
geometry, borders, icons, and palette discipline.

## Consequences

Pixel art punishes half-commitment — partially-pixel UI reads as broken rather than styled — so this
reaches further than a stylesheet:

- **Zoom must snap to integer steps.** Fractional CSS transform scaling destroys pixel crispness, and
  React Flow's `fitView` always lands on a fraction.
- **Edges become `step`, not `bezier`.** Antialiased curves are the least pixel-art element on screen.
- **Geometry snaps to a grid.** Nodes move from 260×132 to 256×128, and ELK's fractional layout
  coordinates get rounded to integers.
- **Every `border-radius` goes to zero.** Including the pill badges and the circular status dots. The
  square status dot is the most legible pixel-art signal on the canvas.
- **The palette becomes a constrained ramp.** Pixel art *is* palette discipline; without it this is
  just flat design. This overrides an earlier instinct to leave the existing colours alone.
- **Animation steps, it does not ease.** Smooth easing is anti-pixel.

Rejected for now: Playwright visual-regression snapshots. They suit pixel art unusually well, since
exact pixel comparison has none of the antialiasing noise that normally makes screenshot tests
flaky — worth revisiting once the look has stabilised, but premature before then.

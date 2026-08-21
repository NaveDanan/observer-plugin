# Spec: the canvas becomes a watching tool

Status: ready-for-agent

## Problem Statement

Observer's interface looks generated rather than designed. A developer opening it sees a neon-glow
logo that means nothing, a minimap navigating a graph of five nodes, a prose strip of capability
jargon, and agent cards wearing six pill-shaped badges. None of these elements were chosen; each is
plausible, and together they read as filler.

Underneath the styling is a worse problem. Observer exists so a developer can watch subagents while
they run, but the canvas answers a question nobody asked. Each node reports totals — how many
messages, how many tool calls, how many todos — which are the aggregates you want *after* a run.
While watching, the only questions are "what is this subagent doing right now?" and "has it been
stuck doing it?" Neither is answerable without clicking into the agent, and by then you have stopped
watching.

The layout compounds it. A three-column overview slab sits above the graph, so the thing the product
is named for gets whatever vertical space is left over.

## Solution

Two changes, and they reinforce each other.

**The canvas becomes a watching surface.** Every agent node reports its current activity — the tool
call running right now, and how long it has been running — instead of lifetime counts. The number
advances while you watch. The graph takes the full stage; the overview slab, the minimap, the
capability strip and the glow mark are deleted rather than restyled.

**The interface commits to a modern pixel-art idiom.** Not as decoration, but because a deliberate
and unusual look is the precise opposite of a generic one, and because the obvious alternative —
picking nicer colours — is itself the most generated-looking move available. The idiom lives in
geometry, borders, icons and palette discipline. It deliberately does not live in typography, which
is where an interface starts reading as a game.

## User Stories

1. As a developer watching a run, I want each subagent node to show the tool call it is executing right now, so that I can follow progress without clicking anything.
2. As a developer watching a run, I want to see how long a subagent has been on its current tool call, so that I can spot one that has hung.
3. As a developer watching a run, I want that elapsed time to advance on screen, so that a displayed duration is never silently stale.
4. As a developer, I want elapsed time to stop advancing once every agent is idle, so that an unattended canvas is not re-rendering forever.
5. As a developer, I want a subagent with nothing running to say so plainly, so that I can distinguish "idle" from "the interface failed to load".
6. As a developer using a host that does not report tool calls at all, I want the node to admit it has no activity data rather than display a guess, so that I keep trusting everything else on the canvas.
7. As a developer, I want a failed subagent to be legible at a glance from across the room, so that I notice failures without reading.
8. As a developer, I want the root agent to be visually distinct from its subagents, so that I read it as context rather than as another thing to monitor.
9. As a developer, I want the agent graph to occupy the entire stage, so that a run with several subagents fits without panning.
10. As a developer, I want the session goal visible at all times, so that I always know which run I am looking at.
11. As a developer, I want session details — host, model, agent count, workspace — reachable without them occupying the stage, so that I can check them when I care and ignore them when I do not.
12. As a developer, I want the todo list of the root agent off the shell, so that a list long enough to need truncating is not competing with the graph.
13. As a developer, I do not want a minimap for a graph I can already see in full, so that the canvas is not carrying navigation nothing needs.
14. As a developer, I do not want a capability fidelity strip written as run-on prose, so that the footer is not spending space on something nobody reads.
15. As a developer, I do not want a decorative glowing mark in the corner, so that every element on screen is carrying information.
16. As a developer, I want the interface to look deliberately designed, so that the tool reads as considered rather than generated.
17. As a developer, I do not want a blocky bitmap display font anywhere, so that a serious tool does not read as a video game.
18. As a developer, I want all running text in an ordinary crisp interface font, so that the tool stays comfortable to read for long stretches.
19. As a developer, I want zoom to snap to whole steps, so that nodes stay pixel-crisp at every zoom level.
20. As a developer, I want the graph to frame itself on a whole zoom step when it fits the view, so that the default view is crisp and not merely close.
21. As a developer, I want edges drawn with hard right-angled corners, so that the graph matches the rest of the idiom instead of contradicting it with smooth curves.
22. As a developer, I want status shown as a hard square rather than a soft circle, so that the canvas signals its idiom in the element I look at most.
23. As a developer, I want state changes to animate in discrete steps, so that motion reads as deliberate rather than as a smooth fade.
24. As a developer, I want a small deliberate colour ramp rather than an assortment of hex values, so that the interface has palette discipline instead of merely flat styling.
25. As a developer opening the project README, I want a screenshot that is legible with no explanation attached, so that I understand what the tool does before installing it.
26. As a developer, I want the delivery-diagnostics warning to survive this redesign, so that I still learn when agents are reporting but Observer cannot record it.
27. As a contributor reading the codebase, I want exactly one word for a coding agent tool, so that I am not guessing whether two names mean two things.
28. As a contributor reading the codebase, I want root agents and subagents named distinctly, so that code about the thing being watched is distinguishable from code about its context.
29. As a maintainer, I want the current-activity logic in a pure function, so that it is testable without a browser or a DOM.
30. As a maintainer, I want the session snapshot to carry current activity, so that the canvas does not need a per-agent fetch to draw a node.
31. As a maintainer, I want current activity delivered over the existing change stream, so that live updates need no second transport.

## Implementation Decisions

### Protocol

The session snapshot gains per-agent current activity: the tool call currently running for that
agent, if any, carried as a distinct field rather than folded into the existing per-agent counts.
Counts remain — they are still correct for the detail panel — they simply stop being what the canvas
draws.

Current activity is nullable and means "no tool call running". A host that never reports tool calls
produces the same null. The interface must render this as an explicit absence, never as a guess.
This follows the existing discipline of reporting an unknown model as unknown rather than inventing
a plausible one.

### Storage

A new projection method returns the running tool call per agent for a session. It is deliberately
*not* folded into the existing counts method: a method named for counts that also returns a tool
call would be one name doing two jobs, which the project glossary exists to prevent.

### Daemon

Snapshot assembly includes the new field. No new endpoint and no new WebSocket channel: tool call
rows already flow over the existing change stream as entity upserts, so the canvas learns about
activity transitions through the same mechanism it already uses for everything else.

### Web store

A new pure selector returns an agent's current activity — the running tool call plus elapsed
milliseconds — or nothing when idle. Elapsed time is derived from the tool call's start timestamp
and a supplied "now", so the function stays pure and clock-independent.

The store currently notifies subscribers only when changes arrive over the WebSocket, so elapsed
time would freeze between events. It gains a one-second tick that runs only while at least one agent
is running, and stops when none is. A discrete once-per-second step is also the correct granularity
for the visual idiom; nothing here needs smoother.

### Canvas and nodes

The node's glance-set becomes: name, status, current activity, time in state. The message, tool-call
and todo count badges are removed. The root agent is rendered distinctly from subagents, reflecting
that it is context rather than subject.

### Shell layout

The stage becomes the canvas and nothing else, at full height. The session goal moves to the topbar,
into the slot freed by deleting the decorative mark. Host, model, agent count and workspace fold
into the active entry in the sessions sidebar, which already displays host and status. The root
agent's todo list, the minimap, the canvas controls and the capability fidelity strip are deleted.
The delivery-diagnostics alert stays exactly as it is.

### Visual conversion

- Typography is unchanged. This is the deliberate line against reading as a game.
- Every corner radius goes to zero, including pill-shaped badges and circular status dots.
- Edges render with hard right-angled corners rather than curves.
- Node dimensions move onto a power-of-two grid, and layout coordinates are rounded to integers.
- Zoom snaps to whole steps; the fit-to-view behaviour selects a whole step rather than a fraction.
- The palette is rebuilt as a small constrained ramp rather than hardened in place.
- Animation uses discrete steps rather than smooth easing.

### Vocabulary

`host` is the single term for a coding agent tool; `harness` is retired everywhere it survives,
including test names and comments. `Agent` is the umbrella term, `root agent` is the agent the
developer drives, `subagent` is any agent with a parent. Definitions live in the project glossary.

## Testing Decisions

A good test here asserts external behaviour: what the snapshot reports, and what a selector returns.
It does not assert on internal structure, and it does not assert on appearance.

**Backend, at the pipeline seam.** Prior art is the existing daemon test suite, which constructs an
in-memory store and a pipeline, feeds a raw host hook payload, and asserts on the projected entities
and the emitted changes. One test at this seam covers the adapter, the reducer, storage and snapshot
assembly in a single pass, so protocol, core, storage and daemon need no separate seams. New
assertions: after a tool-call-start event the snapshot reports that agent's running tool call; after
the matching end event it reports none; an agent that never ran a tool reports none.

**Frontend, at the selector seam.** Prior art is the existing web store test, which builds state
through a small hand-rolled helper and calls selectors as pure functions in a node environment with
no DOM. New assertions: the selector returns the running tool call and correct elapsed milliseconds
for a supplied now; it returns nothing for an idle agent; it picks the running call when an agent has
several completed ones.

**Two seams, not one**, because the daemon and the browser are separate processes with no shared
harness. This is the floor, not a compromise.

**The visual conversion has no test seam and is verified by eye.** This is a deliberate decision, and
it means a substantial share of this spec ships unverified by automation. Reviewers should know that
going in rather than discover it at review.

No DOM test harness is added. No component testing library, no jsdom, no browser automation.

## Out of Scope

- Visual-regression snapshot testing. It suits pixel art unusually well, since exact pixel comparison
  avoids the antialiasing noise that normally makes screenshot tests flaky, but standing up that
  infrastructure before the look has stabilised is premature. Revisit once it has.
- A component test harness of any kind.
- Replacing the graph metaphor. A timeline or trace view would show duration and concurrency that a
  graph cannot, but that is an additional view, not a substitute, and it is not this work.
- Improving the agent detail panel. Forensics stays reachable and stays as it is.
- Supporting additional hosts.
- Changing what events hosts emit or how they are captured.

## Further Notes

Two decision records cover the reasoning behind this spec: one on choosing live-watching over
forensics, one on the pixel-art direction and where the line against looking like a game sits.

The chief risk is half-commitment. Partially-converted pixel art reads as broken rather than styled,
which is worse than the generic look being replaced. The visual conversion should land as a whole,
not trickle in.

The second risk is the palette. Rebuilding it as a constrained ramp reverses an earlier instinct to
leave the colours alone, and it is the part of this work most likely to feel wrong once seen in situ.
It is also the part with no automated safety net.

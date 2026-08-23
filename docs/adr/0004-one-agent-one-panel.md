# One agent, one panel

Observer used to answer questions about a single agent from two places at once. Clicking a node
opened the Worker card on the left (photo, tone, strengths, why they were seated) and the activity
panel on the right (chat, tools, todos). Both were docked, both were permanent, and both were about
the same agent.

That split is now gone. The profile is a **Profile** tab inside the right-hand panel, and the panel
is the only surface that describes an agent.

## Why the split was wrong

It looked principled — identity on one side, work on the other — and the original comment in
`WorkerCard.tsx` said as much. Two things made it not hold up.

**The reader does not have that question.** Nobody arrives at a node asking "is this an identity
question or a work question?" They ask "who is this and what did they do", which is one question
with two halves. Splitting the answer across 700px of screen means the two halves are never in
peripheral vision at the same time, and the reader has to remember which side holds which.

**It priced the canvas out of its own application.** 240px of session list plus 320px of Worker card
plus 380px of activity panel is 940px of chrome. On a 1440px screen the canvas — the thing the
product is named for — got 500px, less than any single panel pair. The existing 1400px breakpoint
already floated the activity panel over the stage to claim some of that back, which is the shape of
a layout apologising for itself.

Folding the profile in returns 320px to the canvas and lets the panel widen from 380px to 420px,
which is what the transcript needed anyway once code blocks arrived in it.

## The Tools tab went the same way, for a stronger reason

Tool calls were a fourth tab beside Chat. That arrangement could tell you the agent said "let me
check the config", and separately that it read four files, but never that those were the same
moment. The ordering key was there — messages carry `createdAt`, calls carry `startedAt` — and the
interface simply declined to use it.

Tool calls are now interleaved into the transcript by `buildTimeline`. Short contiguous runs show one
step per call so the useful subjects — usually file names — stay visible. Runs above the transcript's
disclosure threshold collapse into one summary row and reveal their steps on demand. The merge is
stable within each input rather than a plain sort of the union: the two streams are stamped by
different parts of the host and routinely disagree by a few milliseconds, and sorting the union by
time alone lets that noise reorder two messages — a visible lie about what the agent said first.
Timestamps decide only where one stream interleaves with the *other*.

This is a deletion, not a move. There is no Tools tab, and no setting to bring it back. A tool call
read apart from the sentence that explains it is the thing the merge exists to fix, so keeping both
views would preserve the defect as an option.

## What was given up

**Tool calls are no longer listed newest-first.** The old tab reversed them, which is right for a log
you are scanning for the most recent failure and wrong for a transcript you read top to bottom. The
transcript ordering wins because the tool calls are now part of a narrative rather than a list.

**A run of forty calls is forty rows of chrome in the middle of the conversation.** Mitigated by
collapsing contiguous runs to a single summary row — "Read 12 files" — and by keeping tool rows
deliberately monochrome so prose stays the thing the eye lands on. Colour in the transcript is spent
only on failure and on skill chips.

**The profile is one click away instead of always visible.** Accepted: it is read once when a node is
selected and then ignored while its work is followed. Chat remains the panel's default tab for that
reason, even though Profile is listed first — the tabs are ordered by the question a reader would
ask, and defaulted by the one they actually return to.

## Consequences for ADR 0003

ADR 0003 describes the employee ID card as a carve-out raised from "the Worker card panel". That
panel no longer exists; the `ID CARD` button now lives in the Profile tab. Nothing about the
carve-out's reasoning depends on where the button was, and the card itself is untouched.

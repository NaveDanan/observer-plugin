# Issue tracker: local Markdown

Issues and specs for this repository live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation tickets are one file each at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is a `Status:` line near the top of each ticket. See `triage-labels.md` for the permitted values.
- Conversation history appends under a `## Comments` heading.

## Publishing and reading work

When a skill publishes to the issue tracker, create the relevant file under `.scratch/<feature-slug>/`. When it needs a ticket, read the path the user supplies.

## Wayfinding operations

`/wayfinder` uses a map at `.scratch/<effort>/map.md` and one child ticket per question at `.scratch/<effort>/issues/<NN>-<slug>.md`.

- A ticket records `Type:` as `research`, `prototype`, `grilling`, or `task`.
- A ticket records `Status:` as `claimed` or `resolved`.
- `Blocked by:` lists ticket numbers. A ticket is unblocked when every listed ticket is resolved.
- Claim a ticket by setting `Status: claimed` before work.
- Resolve it by adding an `## Answer` section, setting `Status: resolved`, and adding a short context pointer to the map.

# Observer

Observer watches coding agents while they run. It ingests events from the agent tools a developer
already uses, normalises them into a shared event log, and renders the live agent graph on a canvas.

## Language

**Host**:
A coding agent tool that Observer observes: OpenCode, Codex, Claude Code, or Copilot CLI. Each host
has its own adapter and its own declared capabilities.
_Avoid_: Harness, integration, provider

**Agent**:
The umbrella term for any actor Observer draws on the canvas. Every agent belongs to one session.

**Root agent**:
The agent the developer drives directly. It has no parent. There is one per session.
_Avoid_: Main agent, parent agent, primary

**Subagent**:
Any agent spawned by another. It has a parent. Subagents are what the developer is watching; the
root agent is the context they are watched against.
_Avoid_: Child agent, task, worker

**Employee**:
A persona from the fixed company roster. Every subagent node is drawn as an employee, with their
photo, name, tone and strengths. An agent whose task matches nobody is shown unassigned rather
than given a made-up identity.
_Avoid_: Persona, avatar, worker (as a noun for the profile)

**Roster**:
The full set of employees (`@observer-ai/roster`). Served by the daemon at `/v1/roster`; the
matcher and behaviour directives live in the same package.
_Avoid_: Team, staff list

**Seating / seated**:
What the matcher does when a task arrives: it scores the task text against every employee and
seats the best fit on the node. Seating is advisory metadata; it never changes which host agent
actually runs.
_Avoid_: Assignment (too strong — implies the host was told), matching (fine as a verb)

**Subcontractor**:
A subagent that runs without an employee. Its type says so plainly on the node instead of
borrowing a persona.
_Avoid_: Unassigned (that is the matcher's seating state), fallback agent

**Worker card**:
The left-hand panel that opens with a node click: the employee's profile and why they were
seated. Activity (chat, tools, todos) stays in the right-hand panel.
_Avoid_: Profile panel, detail panel (that is the right side)

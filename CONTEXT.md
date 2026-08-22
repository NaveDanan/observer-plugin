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
seats the best fit on the node. Seating is advisory by default: it labels the node and briefs the
subagent, without changing which host agent runs. Seat control is the one thing that changes that.
_Avoid_: Assignment (too strong — implies the host was told), matching (fine as a verb)

**Seat spec**:
The model, reasoning effort and skills a user assigned to an employee in `seats.employees` in
`~/.observer/config.json`. A seat spec is *desired*: it says what an employee should run with.
It is not seating (the matcher's runtime decision about who fits a task) and it is not an agent's
`model` (observed — see below). Every field is optional; an omitted model means "inherit the
session's model".
_Avoid_: Assignment, agent config, model override

**Seat control**:
The opt-in flag (`seats.control`, off by default) that lets Observer act on the model and effort
in a seat spec, by generating hidden per-employee OpenCode agent definitions and rewriting the
host's `subagent_type`. With it off, model and effort are inert and Observer only observes.
Skills are not gated by it: they are prompt text folded into the behaviour directive, so they
carry none of the risk of pointing the host at an agent that does not exist.
_Avoid_: Enforcement, takeover, steering

**Model**:
On an agent, always the *observed* model — what the host told us it ran, qualified by
`modelConfidence: authoritative | reconciled | inferred`. The model a user *wants* an employee to
run belongs to a seat spec and is never called the agent's model.
_Avoid_: Using bare "model" for a configured preference

**Effort**:
The reasoning level a seat spec asks for, stored under the host's own name for it, `variant`.
OpenCode applies a variant only to an agent's own configured model, so an effort with no model is
a no-op — `diagnoseSeats` reports that rather than accepting it silently. Each model declares its
own subset of the levels, so a level Observer does not recognise is a warning, not an error.
_Avoid_: Reasoning budget, thinking level

**Subcontractor**:
A subagent that runs without an employee. Its type says so plainly on the node instead of
borrowing a persona.
_Avoid_: Unassigned (that is the matcher's seating state), fallback agent

**Finished**:
A subagent whose delegation ran to completion, whichever way the host said so: a `completed`
status from the parent's finished `task` call, or the child session going `idle`. `failed` and
`interrupted` are *ended*, not finished; a root agent going `idle` between turns is *waiting*,
not finished.
_Avoid_: Done, ended

**Subagent ID**:
The host-owned stable identifier for one subagent context. In OpenCode it is the child session id
returned by `task` and accepted later as `task_id`. Observer stores it as `runtimeId`, uses it as a
direct-message address, and never replaces it when a failed or interrupted run resumes.
_Avoid_: Assignment ID (Observer's pre-spawn correlation id), agent key (canvas identity)

**Direct message**:
A durable addressed message from one subagent ID to another in the same session tree. Observer
records it in the recipient's inbox and asks OpenCode to resume the recipient immediately. If the
host cannot do that, the recipient can pull it later with `agent_inbox`.
_Avoid_: Parent relay, broadcast

**Detail panel**:
The right-hand panel that opens with a node click, and the only surface that answers questions
about one agent. Four tabs: **Profile** (the seated employee and why they were seated), **Chat**
(the transcript, with tool calls interleaved into it), **Prompt**, and **Todos**.
_Avoid_: Worker card (this was a separate left-hand panel until the profile was folded in here),
activity panel (the panel is no longer only about activity)

**Transcript**:
The Chat tab's merged view of an agent's messages *and* its tool calls, ordered so a run of calls
sits between the messages it happened between. Built by `buildTimeline`. There is no Tools tab —
a tool call read apart from the sentence that explains it is the thing this merge exists to fix.
_Avoid_: Thread (that is the `<ol>` inside it), tool log

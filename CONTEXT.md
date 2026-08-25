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
seats the best fit on the node. Seating labels and briefs the observed subagent; it never changes
which employee agent the host selects or which model that agent uses.
_Avoid_: Assignment (too strong — implies the host was told), matching (fine as a verb)

**Employee agent**:
A host-native selectable subagent representing one roster employee. Every installed host receives
the full roster, whether or not any seat spec or model pin exists.
_Avoid_: Seated worker, hidden agent

**Seat spec**:
The model pins, host options, and skills a user configures for an employee. It customises an
employee agent but neither creates that agent nor tells the host to select it.
_Avoid_: Assignment, agent config, model override

**Seat control**:
The opt-in flag that activates model pins in seat specs. It never controls whether an employee
agent is available or whether the host selects one; skills apply independently of it.
_Avoid_: Enforcement, takeover, steering

**Model pin**:
A host-specific model and supported reasoning options that an employee agent must use when the
host selects it. Without a pin, the host inherits or chooses the employee agent's model.
_Avoid_: Seat, employee assignment, routing rule

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

**Step**:
One line in the transcript for one thing the agent did — a tool call, or a stretch of thinking.
It says what was done ("Edit toolStep.ts"), how it went (`+7 −6`, "exit 1", "14 matches"), and
opens into a **tool card**. Derived from a raw tool call by `describeToolCall`, which is where
every host's argument vocabulary is reconciled: `filePath` and `path` and `file_path` are the
same fact, and the panel should not care which host said it.
_Avoid_: Tool row, activity line

**Tool card**:
What a step opens into: the arguments the call was given and the output it produced, shown as
what they *are* — a file with its own line gutter, a terminal, a list of matches, a diff — over a
footer carrying the start time, the duration and the output size.
_Avoid_: Tool detail, expando

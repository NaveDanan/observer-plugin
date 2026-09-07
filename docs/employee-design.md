# Employee execution design

Observer has six default employees and two optional specialists. Each employee
has a stable role ID and a familiar Israeli display name. The role appears first
in selection descriptions and the UI. Names and artwork add personality; they
do not imply credentials or organizational authority.

The source of these contracts is `packages/roster/src/contracts.ts`. All four
hosts render the same contract through `behaviorDirective`. Host definitions use
`employeeDescription` for task selection. The lexical matcher indexes selection
criteria, but deliberately excludes handoff text to avoid matching an employee
to a neighbor's specialty. Seating remains an observation; it does not override
the employee agent selected by the host.

## Responsibilities

| Role | Name | Default stage | Typical evidence |
| --- | --- | --- | --- |
| Frontend Engineer | Noam Cohen | implement | Working flow, browser checks |
| Backend Engineer | David Levi | implement | Contract and failure-path tests |
| Product Designer | Yael Mizrahi | design | Annotated flow, states, acceptance criteria |
| Quality Engineer | Daniel Peretz | verify | Independent review, pass/fail/not-run matrix |
| Platform Engineer | Itai Friedman | diagnose | Logs, validated change, rollback checks |
| Research & Data Analyst | Maya Shapiro | research | Sources, metric contracts, reproducible analysis, uncertainty |
| Security Specialist, optional | Tamar Katz | review | Attack reproductions, controls, risk evidence |
| Hardware Specialist, optional | Eitan Dahan | design | Calculations, datasheets, simulation or bench results |

The root agent owns requirements, scope, architecture, capacity assumptions,
ownership, dependency sequencing, and integration. The former CTO, engineering
manager, product director, and program manager are no longer separate agents.
An independent investigation can still be delegated to a relevant specialist.
Research combines the former data science and analytics roles; Security combines
technical security and risk/control assessment.

Employee types are specialties, not a concurrency limit. Multiple instances of
one role can work on disjoint scopes, and a fresh instance can review another's
changes. Small tasks can stay entirely with the root agent.

An assignment can select a different stage. Noam can review UI code without
rewriting it. Tamar can implement an assigned security fix. A request to diagnose
and fix a defect authorizes both stages. The default fills a missing stage; it
does not override the task. Review and verification preserve product code unless
the assignment separately authorizes a repair.

## Delegation and handoffs

Keep small or tightly coupled work in one context. Delegate when an independent
result or isolated investigation justifies the extra coordination. A useful
assignment contains:

```text
Objective: Make the settings form recover from a failed save.
Employee: observer-frontend-engineer
Mode: implement
Inputs: Product acceptance criteria, current form, agreed API error contract.
Ownership: Settings form and its interaction tests. Other agents share this
workspace; preserve their edits. Do not change the service API.
Dependencies: The API error contract is agreed; implementation can proceed.
Deliverable: Working recovery flow and changed-file summary.
Acceptance: Failed save preserves input, presents an accessible error, and
permits a successful retry. Run the relevant interaction checks.
Stop condition: Return after those checks pass, or report the exact blocker
with evidence after discriminating checks stop producing new information.
Handoff: Give Daniel the changed paths and acceptance cases for verification.
```

Choose only the stages needed. Resolve blocking decisions before dependent
implementation. Parallel writes require disjoint ownership and agreed interfaces.
Shared browser state, desktops, migrations, and similar resources have one owner
at a time unless they can be isolated. An employee handoff is a recommendation;
it does not create an agent. The root agent retains integration ownership.

Each result identifies completed, partial, or blocked status, artifacts, changed
files, checks and outcomes, and unresolved inputs or risks. The root inspects the
artifacts and integrates the results. Independent review is useful when the
failure risk warrants it, not as a mandatory stage for every edit.

OpenCode retains its existing single top-level coordinator topology. Codex uses
a self-contained brief with `fork_turns: "none"` where supported. Claude Code
subagents cannot recursively spawn subagents in the documented host model, so
they return needed handoffs to their assigning agent. All hosts respect an
explicit request to work alone.

## Capability discovery and tools

Security and Hardware are off by default. Enable each in Settings > Employees,
or the employee detail screen in `observer config`. The equivalent configuration
is `seats.employees.security-specialist.enabled: true` or
`seats.employees.hardware-specialist.enabled: true`. This works independently of
seat control. Existing model pins alone do not enable a specialist. Disabling
preserves settings and removes Observer-owned agent definitions on the next sync.
Saving in `observer config` regenerates host definitions. After changing the web
settings, rerun the installation command used for each host, preserving `--plugin`
if applicable. Restart the host and start a new session to pick up the change.

The settings catalog contains all eight employees. Automatic matching, the compact
`employee_brief` list, and generated host definitions contain only enabled roles.
A direct brief lookup can inspect a disabled specialist and returns `enabled: false`.

Legacy IDs for surviving employees resolve to the new role IDs, including for
observed history and saved seat settings. `dr-mei-lin` and `dr-maya-chen` both map
to `research-analyst`; `nia-okafor` and `adrian-cole` map to `security-specialist`.
When settings conflict, the canonical role ID wins, then the original technical
specialist, then its merged colleague. A diagnostic explains this precedence;
the other entries remain in the configuration. Editing a current employee writes
its canonical ID. Clearing it masks any legacy settings with an empty canonical
entry so they do not reactivate. Retired management settings remain stored and
inactive, with an explanatory diagnostic. Only Observer-owned host files are
replaced or removed during sync.

`packages/roster/src/capabilities.ts` assigns each employee a small set of
capability preferences. These describe how to discover suitable tools and what
to do if they are missing. They do not install plugins, grant credentials, enforce
a sandbox, or prove tool availability. Actual restrictions belong to the host.
Model pins and the user's Pass All Skills setting remain in force. The Default
skill inventory is still available when enabled; employees load relevant skill
instructions rather than applying the whole inventory to every task.

The built-in `employee_brief` tool retrieves the current contract from the
authenticated local daemon. Codex, Claude Code, and Copilot receive it through
Observer's coordination MCP server:

```json
{ "employeeId": "frontend-engineer", "mode": "review" }
```

Omit both arguments for a compact list. A mode requires an employee ID. The
response includes the selected stage, default contract, capability preferences
marked `discover-in-host`, and instructions with configured skill preferences.
It does not spawn an agent or modify model pins. Invalid IDs or modes produce
errors. A stopped daemon produces an unavailable-tool result, not a fabricated
brief.

OpenCode exposes a native `employee_brief` tool with an `employeeId` argument.
Use an empty string to list employees. Assign the stage in the task prompt.
The authenticated HTTP equivalent is `GET /v1/roster/brief`, with optional
`employeeId` and `mode` query parameters.

For live interfaces, Noam, Yael, and Daniel prefer existing browser automation
or a purpose-built connector. When native computer use is exposed, they read
its instructions and follow an observe, act, inspect loop. A Codex desktop tool
cannot simply be called from another host. The optional
[Playwright MCP configuration](../integrations/playwright/README.md) supplies
browser automation to compatible hosts; it does not control native desktop apps.

## Design basis and evaluation

Primary sources checked on 2026-09-07:

- [Israel CBS given-name tables](https://www.cbs.gov.il/he/mediarelease/DocLib/2014/312/11_14_312e.pdf)
  supplied a reference for familiar Israeli given names. Employee names remain
  fictional presentation choices.

- [OpenAI subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
  describes isolated contexts, bounded work, summarized results, and the extra
  care required for concurrent writes. Observer uses these as design constraints
  rather than assuming more agents always improve a task.
- [Anthropic's multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
  motivates precise delegation, effort proportional to task complexity, and
  evaluation of the complete workflow. Its research benchmark is not evidence
  that these Observer prompts improve coding performance.
- [Claude Code custom subagents](https://code.claude.com/docs/en/sub-agents)
  documents description-based selection, separate tool access, skill handling,
  and restrictions on nested subagents. Observer describes capabilities without
  assuming identical behavior across hosts.
- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)
  documents isolated browser contexts and conflicts when concurrent clients
  share a persistent profile. Observer assigns browser ownership explicitly.

Automated checks cover contract completeness, valid handoffs and capabilities,
prompt size, stage selection, compatibility with older profiles, skill rendering,
authenticated brief retrieval, MCP transport, and native host definition generation.
These checks establish the wiring and contract invariants. They do not measure
LLM task success.

Before claiming a behavioral improvement, compare the old and new definitions
on repeated representative tasks with fixed inputs and model settings. Include
a local UI repair, service regression, ambiguous diagnosis, independent review,
an unavailable browser tool, and a request to work alone. Score correct outcomes,
unsupported claims, out-of-scope writes, duplicate work, tool failures, cost, and
latency. Record actual artifacts and traces, not just final-answer quality.

## Loading the change

Build and install Observer using the repository's existing release workflow.
Reinstall the relevant host integration to regenerate its employee definitions,
then restart the daemon and start a new host session. Codex and Copilot plugin
installs also need their host's plugin cache refreshed through the normal install
flow. Definitions already loaded into a running session do not change in place.
Observer preserves user-owned agent files whose ownership marker was removed.

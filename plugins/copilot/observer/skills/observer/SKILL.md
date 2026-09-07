---
name: observer
description: Use when the user asks to set up Observer, inspect its local agent canvas, or explicitly invokes Observer to coordinate delegated work.
---

# Observer

## Setup and status

Resolve this plugin's root two directories above this SKILL.md. When the user requests setup, run `node "<plugin-root>/scripts/setup.mjs"`. This downloads the pinned Observer release, verifies its SHA-256, installs it under ~/.observer/runtimes/0.9.21, and starts the local daemon. Requires Node.js 22.5+ and npm. Setup adds missing Codex employee definitions when applicable; existing definitions are preserved. Restart the host after setup to load agents and MCP tools. In Codex, approve the Observer hooks using /hooks.

For status run `node "<plugin-root>/scripts/cli.mjs" status`; to open the canvas run `node "<plugin-root>/scripts/cli.mjs" open`. Do not run observer install for the same host: this marketplace already supplies its hooks. If another Observer installation already supplies hooks, use only one plugin or hook installation to avoid duplicate events.

## Delegation

Use this section only when the user explicitly asks Observer to coordinate work.

## Employee roster
You can delegate work to subagents when authorized. Respect a request to work alone. Keep small, tightly coupled work local; delegate when a bounded independent result or isolated investigation earns the coordination cost. Prefer an employee agent whose task specialty fits; titles do not establish a management chain.
- `observer-frontend-engineer`: Frontend Engineer · Noam Cohen. Select to implement UI components, interaction state, accessibility fixes, or measured frontend performance improvements.
- `observer-backend-engineer`: Backend Engineer · David Levi. Select to implement APIs, database changes, authentication behavior, queues, or service reliability fixes.
- `observer-product-designer`: Product Designer · Yael Mizrahi. Select to design user flows, information architecture, visual hierarchy, prototypes, or usability improvements.
- `observer-quality-engineer`: Quality Engineer · Daniel Peretz. Select to review code, reproduce bugs, design regression coverage, verify acceptance criteria, or test completed changes independently.
- `observer-platform-engineer`: Platform Engineer · Itai Friedman. Select to diagnose operational incidents, repair CI/CD, implement infrastructure, or prepare rollout and rollback procedures.
- `observer-research-analyst`: Research & Data Analyst · Maya Shapiro. Select to research technical questions, define KPIs, audit data quality and lineage, design experiments, evaluate AI agents or ML models, forecast, or test causal claims.

## Delegation workflow
The root agent owns requirements, product scope, architecture, ownership, dependency sequencing, and integration. Define the user outcome and observable acceptance criteria. For consequential architecture decisions, compare viable options with the current approach, record tradeoffs and migration/rollback limits, and identify a small evaluation for uncertainty. Base capacity and dates on supplied evidence; map dependencies and unblock decisions before assigning work. Delegate an independent investigation when it needs separate context, then make and integrate the decision locally.
Employee types are specialties, not a fixed headcount. Several instances of one specialty can work on independent scopes. A fresh instance can review another instance's changes. Use only as many agents as the task justifies.
1. Choose only the stages needed: research, diagnose, design, implement, review, verify, or plan. Resolve blocking decisions before dependent implementation. One employee can cover several stages; staffing every role is unnecessary.
2. Give each subagent an objective, explicit mode, relevant inputs and decisions, owned files/resources, dependencies, deliverable, acceptance checks, and stop condition. Say that other agents share the workspace and their edits must be preserved. For Codex, prefer `fork_turns: "none"` with a self-contained brief; use the actual host's supported context controls elsewhere.
3. Dispatch independent work together within the host's available limits. Parallel edits require disjoint ownership and agreed interfaces; serialize shared files and browser/desktop state. Keep integration-critical work local while independent investigations run.
4. Share dependency-relevant facts through available peer messaging. Reuse existing agents for revisions. If a host cannot deliver directly, collect the handoff through the assigning agent. Avoid recursive delegation unless explicitly needed and authorized.
5. Inspect returned artifacts and verification evidence, resolve conflicting findings, and run integration checks. Use independent review when failure risk warrants it. Stop only when the requested result is verified or the remaining blocker is explicit.
Use employee_brief when exposed to retrieve the currently enabled roster or one employee's contract and work mode. Security and Hardware are optional specialists, off by default; use them only when enabled and registered in the current host. It describes capability preferences, not installed tools.
If no employee fits, an available default subagent is legitimate and Observer records it as a "subcontractor". In the final response, state the reason no employee agent was selected when delegation used that fallback.

Select employee agents from the host's actual available agent list. If one is unavailable, use employee_brief when available and pass the relevant contract in the delegated prompt. Explain any default-agent fallback. Discover current tools and skills before using them. Complete the root task after collecting results.

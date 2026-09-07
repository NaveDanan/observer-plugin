import type { EmployeeWorkContract } from "./types.js"

/** Task contracts, independent of employee names and assignment stages. */
export const EMPLOYEE_CONTRACTS: Record<string, EmployeeWorkContract> = {
  "frontend-engineer": {
    "mission": "Implement usable, accessible interfaces with explicit state and component boundaries.",
    "selection": "implement UI components, interaction state, accessibility fixes, or measured frontend performance improvements",
    "defaultMode": "implement",
    "workflow": [
      "Trace the user flow, existing components, data contracts, and design constraints.",
      "Implement the smallest complete flow, including loading, empty, error, and keyboard states.",
      "Inspect the running UI at relevant viewport sizes and check affected behavior."
    ],
    "deliverables": [
      "Working UI changes with component and state decisions",
      "Browser evidence and relevant interaction checks"
    ],
    "verification": [
      "Keyboard focus, accessible names, and responsive layout work for the changed flow.",
      "Performance claims include a baseline and a comparable measurement."
    ],
    "boundaries": [
      "Return unresolved product scope to the root agent; involve the Product Designer for interaction direction."
    ],
    "handoffs": [
      {
        "employeeId": "product-designer",
        "when": "interaction or visual requirements are unresolved"
      },
      {
        "employeeId": "backend-engineer",
        "when": "the flow needs an API or persistence contract"
      },
      {
        "employeeId": "quality-engineer",
        "when": "the completed flow needs independent regression verification"
      }
    ],
    "capabilities": [
      "code",
      "browser",
      "design"
    ]
  },
  "backend-engineer": {
    "mission": "Implement service and persistence behavior that remains correct under failure and concurrency.",
    "selection": "implement APIs, database changes, authentication behavior, queues, or service reliability fixes",
    "defaultMode": "implement",
    "workflow": [
      "Trace the request or event through storage and its callers; identify invariants.",
      "Define compatibility, error behavior, transaction boundaries, and retry semantics before changing code.",
      "Implement the bounded change and exercise success, failure, and concurrency paths that bear on it."
    ],
    "deliverables": [
      "Service changes and explicit input/output contracts",
      "Migration or compatibility notes when storage or public APIs change"
    ],
    "verification": [
      "Tests exercise the changed invariant through the public boundary.",
      "Retries, partial failures, authorization, and existing data are accounted for where relevant."
    ],
    "boundaries": [
      "Coordinate infrastructure rollout with the Platform Engineer; return cross-system architecture decisions to the root agent."
    ],
    "handoffs": [
      {
        "employeeId": "frontend-engineer",
        "when": "an API contract is ready for UI integration"
      },
      {
        "employeeId": "security-specialist",
        "when": "authorization or a trust boundary changes"
      },
      {
        "employeeId": "platform-engineer",
        "when": "deployment or migration execution needs operational ownership"
      }
    ],
    "capabilities": [
      "code",
      "data",
      "research"
    ]
  },
  "product-designer": {
    "mission": "Resolve interaction and visual decisions into an implementable, accessible design.",
    "selection": "design user flows, information architecture, visual hierarchy, prototypes, or usability improvements",
    "defaultMode": "design",
    "workflow": [
      "Inspect the current product and supplied user evidence; identify the task users need to complete.",
      "Define the flow and visual hierarchy with the existing design system or a justified direction.",
      "Specify responsive, keyboard, error, empty, and loading behavior; inspect a prototype when available."
    ],
    "deliverables": [
      "Annotated flow, prototype, or design changes with implementation guidance",
      "Acceptance criteria for interaction and accessibility"
    ],
    "verification": [
      "Every critical state has a defined user action and outcome.",
      "Distinguish observed usability findings from assumptions that need user research."
    ],
    "boundaries": [
      "Return unresolved user outcomes and product scope to the root agent; production component implementation belongs to the Frontend Engineer unless assigned."
    ],
    "handoffs": [
      {
        "employeeId": "frontend-engineer",
        "when": "the design is ready to implement"
      },
      {
        "employeeId": "quality-engineer",
        "when": "a flow needs independent usability or accessibility verification"
      }
    ],
    "capabilities": [
      "browser",
      "design",
      "research"
    ]
  },
  "quality-engineer": {
    "mission": "Establish whether a change satisfies its contract and detect consequential regressions.",
    "selection": "review code, reproduce bugs, design regression coverage, verify acceptance criteria, or test completed changes independently",
    "defaultMode": "verify",
    "workflow": [
      "Read the requirements and changed boundaries; choose checks by failure risk.",
      "Reproduce the reported behavior or establish a baseline before judging the change.",
      "Run focused integration, exploratory, or browser checks; record exact failures and their environment."
    ],
    "deliverables": [
      "Acceptance matrix with pass, fail, or not-run status and evidence",
      "Minimal reproductions and maintainable regression tests where justified"
    ],
    "verification": [
      "Checks assert observable behavior and can fail for the defect they target.",
      "A passing subset is not reported as complete coverage; flaky and environment failures are identified."
    ],
    "boundaries": [
      "Verify mode preserves product code; return defects to the implementation owner unless assigned the fix.",
      "Do not approve a change solely from its author's summary."
    ],
    "handoffs": [
      {
        "employeeId": "frontend-engineer",
        "when": "a failure is in UI behavior"
      },
      {
        "employeeId": "backend-engineer",
        "when": "a failure is in service behavior"
      },
      {
        "employeeId": "platform-engineer",
        "when": "the test environment or pipeline prevents verification"
      }
    ],
    "capabilities": [
      "code",
      "browser",
      "operations"
    ]
  },
  "platform-engineer": {
    "mission": "Make delivery and operation reproducible, observable, and recoverable.",
    "selection": "diagnose operational incidents, repair CI/CD, implement infrastructure, or prepare rollout and rollback procedures",
    "defaultMode": "diagnose",
    "workflow": [
      "Establish the affected environment, current revision, impact, and recent changes.",
      "Use logs, metrics, traces, and configuration to test the most likely failure explanation.",
      "Prepare the smallest repair, validate it in an appropriate environment, and specify rollout and rollback checks."
    ],
    "deliverables": [
      "Evidence-backed operational diagnosis or infrastructure change",
      "Executable validation, rollout, and rollback steps with observable stop conditions"
    ],
    "verification": [
      "Configuration validates and the relevant delivery path has been exercised.",
      "Recovery claims identify the tested environment and any untested production step."
    ],
    "boundaries": [
      "Production access follows the task authorization; the role grants no deployment authority.",
      "Return service logic repairs to the Backend Engineer and multi-owner cutover decisions to the root agent."
    ],
    "handoffs": [
      {
        "employeeId": "backend-engineer",
        "when": "the incident originates in service logic"
      },
      {
        "employeeId": "security-specialist",
        "when": "evidence suggests compromise or exposed credentials"
      }
    ],
    "capabilities": [
      "code",
      "operations",
      "research"
    ]
  },
  "research-analyst": {
    "mission": "Answer research and data questions with traceable sources, trustworthy metrics, and reproducible analysis.",
    "selection": "research technical questions, define KPIs, audit data quality and lineage, design experiments, evaluate AI agents or ML models, forecast, or test causal claims",
    "defaultMode": "research",
    "workflow": [
      "For source research, define the question, consult current primary sources, and distinguish supported findings from inference. For data work, define grain, denominator, time window, lineage, freshness, and join cardinality.",
      "Define the decision, hypothesis, unit of analysis, and available data provenance.",
      "Choose a baseline, valid split or experimental design, metrics, and uncertainty treatment before interpreting results.",
      "Run reproducible analysis; inspect leakage, confounding, error slices, and sensitivity to assumptions."
    ],
    "deliverables": [
      "Reproducible analysis or evaluation with data provenance",
      "Decision-relevant findings, uncertainty, and limits",
      "Sourced research findings or metric/data contracts with reproducible queries and reconciliation"
    ],
    "verification": [
      "Evaluation data is separated from tuning and includes relevant failure cases.",
      "Agent evaluations measure task outcomes, tool failures, cost, and latency where available; repeated trials expose variability.",
      "Citations support the actual claim; conflicting evidence and missing sources are identified.",
      "Metric changes reconcile with source data and explain comparability with historical reporting."
    ],
    "boundaries": [
      "Return product priority and architecture decisions to the root agent. Findings must distinguish source facts, inference, and untested assumptions."
    ],
    "handoffs": [
      {
        "employeeId": "backend-engineer",
        "when": "a validated model or evaluation needs service integration"
      }
    ],
    "capabilities": [
      "data",
      "research",
      "code",
      "documents"
    ]
  },
  "security-specialist": {
    "mission": "Validate realistic attack paths and connect technical evidence to proportionate controls and risk decisions.",
    "selection": "threat-model changes, review authorization, validate vulnerabilities, implement security fixes, assess organizational risk, or map policy controls to evidence",
    "defaultMode": "review",
    "workflow": [
      "Map assets, entry points, attacker capabilities, and trust boundaries for the assigned scope.",
      "Trace plausible abuse paths and validate them with bounded, authorized tests.",
      "Prioritize demonstrated impact and propose or implement the smallest effective mitigation within the assigned mode.",
      "For policy or governance work, identify obligations and risk owners, map controls to evidence, and propose treatment with measurable follow-up."
    ],
    "deliverables": [
      "Findings with preconditions, affected code, impact, and reproduction evidence",
      "Mitigations and regression checks, or an explicit no-findings result with coverage limits",
      "Risk/control assessment or policy proposal with evidence gaps and accountable decision owners"
    ],
    "verification": [
      "Findings distinguish demonstrated behavior from untested hypotheses.",
      "A fix blocks the abuse case and preserves the legitimate flow.",
      "Compliance claims are limited to reviewed evidence and applicable scope; risk acceptance remains an authorized-owner decision."
    ],
    "boundaries": [
      "Review mode reports findings; product changes require an implementation assignment.",
      "Risk acceptance and compliance decisions remain with the authorized user; return decision proposals through the root agent."
    ],
    "handoffs": [
      {
        "employeeId": "backend-engineer",
        "when": "a service contract must change to close the attack path"
      },
      {
        "employeeId": "platform-engineer",
        "when": "containment or credential rotation needs operational execution"
      }
    ],
    "capabilities": [
      "code",
      "security",
      "research",
      "documents"
    ]
  },
  "hardware-specialist": {
    "mission": "Turn electrical and embedded requirements into a design supported by calculations and measurements.",
    "selection": "design or review circuits, select components, debug embedded interfaces, or analyze power and signal integrity",
    "defaultMode": "design",
    "workflow": [
      "Establish electrical limits, interfaces, environment, and source datasheets.",
      "Analyze tolerances, timing, power, thermal behavior, and credible failure modes.",
      "Produce the bounded design or firmware change and define simulation and bench checks."
    ],
    "deliverables": [
      "Design artifacts or embedded changes with calculations and component references",
      "Simulation results and a bench validation procedure"
    ],
    "verification": [
      "Component ratings and assumptions cite the exact datasheet revision.",
      "Simulation, calculation, and physical measurement are labeled separately; bench results are never inferred."
    ],
    "boundaries": [
      "Physical equipment and fabrication steps require available hardware and task authorization."
    ],
    "handoffs": [
      {
        "employeeId": "security-specialist",
        "when": "firmware introduces a security or update trust boundary"
      },
      {
        "employeeId": "quality-engineer",
        "when": "a hardware/software interface needs a repeatable validation procedure"
      }
    ],
    "capabilities": [
      "hardware",
      "code",
      "research"
    ]
  }
}

import type { WorkMode } from "./types.js"

/** The assignment selects a mode; the employee supplies domain expertise. */
export const WORK_MODES: Record<WorkMode, string> = {
  research: "Answer a bounded question. Inspect primary evidence, separate facts from inference, and return a conclusion with sources and uncertainty. Write only requested research artifacts.",
  diagnose: "Establish a reproduction or baseline. Rank hypotheses, run the cheapest discriminating check, and revise from evidence. Return the cause or remaining hypotheses with the next useful check. Repair only when the assignment includes fixing it.",
  design: "Inspect constraints and existing patterns. Resolve required decisions, specify interfaces and states, and return an implementable artifact with acceptance criteria. Prototype within assigned ownership.",
  implement: "Read existing behavior and affected callers. Change owned files or modules, preserve others' edits, and run checks that exercise the requested behavior. Return the change and verification evidence.",
  review: "Inspect the actual artifact and requirements independently. Preserve the implementation. Return actionable findings with location, trigger, impact, and evidence, or no findings with coverage limits. Review does not authorize merging.",
  verify: "Derive checks from acceptance criteria and failure risk. Exercise the actual result and record pass, fail, or not-run evidence. Preserve product code; change test or report artifacts only when assigned.",
  plan: "Turn the agreed objective into owned deliverables, dependencies, readiness conditions, and completion checks. Distinguish estimates from commitments. Producing a plan does not execute it or spawn agents.",
}

export function isWorkMode(value: unknown): value is WorkMode {
  return typeof value === "string" && Object.hasOwn(WORK_MODES, value)
}

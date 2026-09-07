/**
 * The company roster: the fixed cast of employee personas a subagent can be
 * seated as. One employee maps to one subagent node; the matcher decides who.
 */

export interface EmployeeProfile {
  id: string
  /** Optional specialists are selectable only after explicit enablement. */
  optional?: boolean
  fullName: string
  title: string
  yearsOfExperience: number
  experienceSummary: string
  shortDescription: string
  /** How the employee talks and explains decisions. Drives the persona voice. */
  tone: string
  /** Named capabilities, used for matching and shown on the node/card. */
  fields: string[]
  contribution: string
  /** Concrete situations that call for this employee. Strong match signals. */
  youCallThemWhen: string[]
  animal: string
  animalWhy: string
  /** File name inside the UI's /roster image directory. */
  imageFile: string
  /** Configured skill preferences; availability is resolved by the host. */
  skills: EmployeeSkill[]
  /** Execution contract. Optional for profiles supplied by older clients. */
  work?: EmployeeWorkContract
}

export type WorkMode = "research" | "diagnose" | "design" | "implement" | "review" | "verify" | "plan"

export interface EmployeeWorkContract {
  mission: string
  /** Task-shaped selection guidance used by every host. */
  selection: string
  defaultMode: WorkMode
  workflow: string[]
  deliverables: string[]
  verification: string[]
  boundaries: string[]
  handoffs: { employeeId: string; when: string }[]
  /** Capability preferences, never an assertion that a tool is installed. */
  capabilities: string[]
}

export interface EmployeeSkill {
  name: string
  description: string
}

/** Profile shape served over the API, with the UI image URL resolved. */
export interface RosterProfile extends EmployeeProfile {
  imageUrl: string
}

/** Why the matcher seated this employee on a node. */
export interface MatchReason {
  kind: "skill" | "trigger" | "role"
  /** The matched term or trigger phrase. */
  detail: string
}

export interface EmployeeMatch {
  profile: RosterProfile
  score: number
  reasons: MatchReason[]
}

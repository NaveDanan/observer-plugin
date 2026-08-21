/**
 * The company roster: the fixed cast of employee personas a subagent can be
 * seated as. One employee maps to one subagent node; the matcher decides who.
 */

export interface EmployeeProfile {
  id: string
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
  /**
   * Per-employee skills, reserved for future use. Empty for now; the worker
   * card renders the section only when an employee has skills.
   */
  skills: EmployeeSkill[]
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

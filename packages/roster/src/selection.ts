import { ROSTER } from "./roster.js"
import type { EmployeeProfile, RosterProfile } from "./types.js"

/** Ordered by precedence after the canonical role ID. Saved legacy keys remain readable. */
export const LEGACY_EMPLOYEE_IDS: Record<string, readonly string[]> = {
  "frontend-engineer": ["arjun-mehta"],
  "backend-engineer": ["malik-johnson"],
  "product-designer": ["sofia-moreno"],
  "quality-engineer": ["daniel-brooks"],
  "platform-engineer": ["elias-mercer"],
  "research-analyst": ["dr-mei-lin", "dr-maya-chen"],
  "security-specialist": ["nia-okafor", "adrian-cole"],
  "hardware-specialist": ["ravi-menon"],
}

export const RETIRED_EMPLOYEE_IDS = ["leila-haddad", "marcus-reed", "elena-vargas", "omar-rahman"] as const

export function canonicalEmployeeId(id: string): string {
  return Object.entries(LEGACY_EMPLOYEE_IDS).find(([, aliases]) => aliases.includes(id))?.[0] ?? id
}

/** Canonical settings win, then the original technical specialist, then its merged colleague. */
export function employeeSetting<T>(settings: Record<string, T> | undefined, id: string): T | undefined {
  if (!settings) return undefined
  const canonical = canonicalEmployeeId(id)
  const aliases = Object.hasOwn(LEGACY_EMPLOYEE_IDS, canonical) ? LEGACY_EMPLOYEE_IDS[canonical]! : []
  for (const key of [canonical, ...aliases]) {
    if (Object.hasOwn(settings, key)) return settings[key]
  }
  return undefined
}

export function employeeEnabled(profile: EmployeeProfile, spec?: { enabled?: boolean }): boolean {
  return profile.optional !== true || spec?.enabled === true
}

export function activeEmployees(config?: { employees: Record<string, { enabled?: boolean }> }): RosterProfile[] {
  return ROSTER.filter((profile) => employeeEnabled(profile, employeeSetting(config?.employees, profile.id)))
}

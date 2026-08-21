import { EMPLOYEES } from "./data.js"
import type { EmployeeProfile, RosterProfile } from "./types.js"

/** The roster with UI image URLs resolved. */
export const ROSTER: RosterProfile[] = EMPLOYEES.map((profile) => ({
  ...profile,
  imageUrl: `/roster/${profile.imageFile}`,
}))

const BY_ID = new Map<string, RosterProfile>(ROSTER.map((profile) => [profile.id, profile]))

export function getEmployee(id: string): RosterProfile | undefined {
  return BY_ID.get(id)
}

export function withImageUrls(profiles: EmployeeProfile[]): RosterProfile[] {
  return profiles.map((profile) => ({ ...profile, imageUrl: `/roster/${profile.imageFile}` }))
}

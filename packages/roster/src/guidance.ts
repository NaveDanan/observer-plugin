import type { EmployeeProfile } from "./types.js"

/**
 * Persona guidance rendered from a profile.
 *
 * These strings are injected into agent prompts (system briefing, delegation
 * prompts) so the model knows who is on the roster and how the person it is
 * playing behaves. Kept short: prompt budgets are real.
 */

/** The per-subagent behaviour block appended to a delegation prompt. */
export function behaviorDirective(profile: EmployeeProfile, task?: string): string {
  const lines = [
    `You are ${profile.fullName}, ${profile.title} (${profile.experienceSummary}).`,
    `Voice: ${profile.tone}`,
    `Play to your strengths: ${profile.fields.join(", ")}.`,
  ]
  if (task && task.trim().length > 0) {
    lines.push(`Apply that expertise to this task: ${task.trim()}`)
  }
  if (profile.skills.length > 0) {
    lines.push(`Skills available to you: ${profile.skills.map((skill) => skill.name).join(", ")}.`)
  }
  return lines.join("\n")
}

/**
 * The roster section injected into the root agent's system prompt.
 *
 * This is the offer: it tells the model subagents are available and names the
 * employees it can staff them with. Declining the offer is legitimate — an
 * unstaffed subagent is recorded as a "subcontractor" rather than given a
 * made-up identity.
 */
export function rosterBriefing(profiles: EmployeeProfile[]): string {
  const rows = profiles
    .map((profile) => {
      const strengths = profile.fields.slice(0, 4).join(", ")
      return `- ${profile.fullName} — ${profile.title}: strong at ${strengths}.`
    })
    .join("\n")
  return [
    "## Team roster",
    "You can delegate work to subagents. These employees are available to staff them: pick the teammate whose strengths fit the task and describe the task in their terms, so Observer seats them on the node:",
    rows,
    'If no teammate fits a task, delegate anyway without naming one: that subagent is recorded as a "subcontractor".',
  ].join("\n")
}

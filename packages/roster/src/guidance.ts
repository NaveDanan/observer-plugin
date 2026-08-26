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
      const strengths = profile.fields.join(", ")
      return `- \`observer-${profile.id}\` — ${profile.fullName}, ${profile.title}: ${strengths}.`
    })
    .join("\n")
  return [
    "## Employee roster",
    "You can delegate work to subagents. Prefer an employee agent whose capabilities fit the delegated task instead of a default Codex agent. Give each spawn a complete, bounded instruction and set `fork_turns: \"none\"` so root chat and plugin bootstrap context stay in the root agent:",
    rows,
    'If no employee fits, a default Codex subagent is legitimate and Observer records it as a "subcontractor". In the final response, state the reason no employee agent was selected.',
  ].join("\n")
}

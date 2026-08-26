/**
 * The one Codex hook decision Observer owns.
 *
 * Observer subagents start from their delegated instruction instead of a copy
 * of the root transcript. This keeps root chat, app bootstrap messages, and
 * plugin availability metadata out of the subagent's context.
 */
export interface CodexSpawnSkill {
  name: string
  description: string
  path: string
  scope: string
}

export interface CodexSpawnControl {
  passAllSkills?: boolean
  skills?: CodexSpawnSkill[]
}

const SKILL_PACK_MARKER = "## Observer skills available to this subagent"

export function codexHookOutput(
  event: string,
  payload: unknown,
  control: CodexSpawnControl = {},
): Record<string, unknown> | undefined {
  if (event !== "PreToolUse" || !isRecord(payload)) return undefined
  const tool = normalizeTool(payload["tool_name"])
  if (tool !== "agent" && tool !== "spawnagent" && tool !== "collaborationspawnagent") return undefined

  const toolInput = payload["tool_input"]
  if (!isRecord(toolInput)) return undefined
  const updatedInput: Record<string, unknown> = { ...toolInput, fork_turns: "none" }
  if (control.passAllSkills !== false && Array.isArray(control.skills) && control.skills.length > 0) {
    const field = instructionField(tool, toolInput)
    const instruction = typeof toolInput[field] === "string" ? toolInput[field] : ""
    if (!instruction.includes(SKILL_PACK_MARKER)) updatedInput[field] = appendSkills(instruction, control.skills)
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  }
}

function instructionField(tool: string, input: Record<string, unknown>): "message" | "prompt" {
  if (typeof input["message"] === "string") return "message"
  if (typeof input["prompt"] === "string") return "prompt"
  return tool === "agent" ? "prompt" : "message"
}

function appendSkills(instruction: string, skills: CodexSpawnSkill[]): string {
  const lines = [
    instruction.trimEnd(),
    "",
    SKILL_PACK_MARKER,
    "Observer resolved these enabled skills from Codex for the current project. Use a skill when the user names it or the delegated task matches its description. Read its SKILL.md completely before acting.",
  ]
  for (const skill of skills) {
    const description = skill.description.replace(/\s+/g, " ").trim() || "No description provided."
    lines.push(`- ${skill.name} [${skill.scope}]: ${description}`, `  SKILL.md: ${skill.path}`)
  }
  return lines.join("\n").trimStart()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeTool(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : ""
}

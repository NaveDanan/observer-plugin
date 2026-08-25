import type { HostId } from "./events.js"

/**
 * Honest, per-host capability declarations.
 *
 * The UI renders these directly. Observer never implies it can show data that a
 * host does not expose, so every field here is either "what we get" or an
 * explicit gap.
 */
export interface HostCapabilities {
  host: HostId
  label: string
  /** Live assistant text while the turn is still running. */
  liveAssistantText: "stream" | "batched" | "final-only" | "none"
  /** Can the parent -> child relationship be established with real ids? */
  agentGraph: "authoritative" | "reconciled" | "inferred" | "none"
  /** Structured task/todo list. */
  todos: "authoritative" | "reconciled" | "none"
  /** Session-level objective. */
  goals: "authoritative" | "derived" | "none"
  /** Which model each agent runs. */
  model: "authoritative" | "partial" | "none"
  /** How much of the effective system prompt is observable. */
  systemPrompt: "partial" | "config-only" | "none"
  /** Free-form notes rendered in the UI's fidelity panel. */
  notes: string[]
}

export const HOST_CAPABILITIES: Record<HostId, HostCapabilities> = {
  opencode: {
    host: "opencode",
    label: "OpenCode",
    liveAssistantText: "stream",
    agentGraph: "authoritative",
    todos: "authoritative",
    goals: "derived",
    model: "authoritative",
    systemPrompt: "partial",
    notes: [
      "Message part deltas give token-level streaming.",
      "Child sessions carry parentID, so the graph is exact.",
      "Agent definition prompts are available; vendor base prompt is not separately exposed.",
    ],
  },
  codex: {
    host: "codex",
    label: "Codex",
    liveAssistantText: "final-only",
    agentGraph: "reconciled",
    todos: "reconciled",
    goals: "derived",
    model: "authoritative",
    systemPrompt: "config-only",
    notes: [
      "Hook mode reports the final assistant message per turn, not deltas.",
      "Todos are reconstructed from update_plan tool calls.",
      "Every hook payload includes the active model slug.",
      "The composed system prompt is not exposed; only configured developer instructions are.",
    ],
  },
  claude: {
    host: "claude",
    label: "Claude Code",
    liveAssistantText: "batched",
    agentGraph: "reconciled",
    todos: "reconciled",
    goals: "derived",
    model: "partial",
    systemPrompt: "config-only",
    notes: [
      "MessageDisplay delivers newly completed lines, not tokens.",
      "SubagentStart has no parent id; the edge is joined via the Agent tool call.",
      "Main model is only reported at SessionStart and may drift after /model.",
      "Built-in system prompt is not exposed; instruction files are tracked instead.",
    ],
  },
  copilot: {
    host: "copilot",
    label: "GitHub Copilot CLI",
    liveAssistantText: "none",
    agentGraph: "reconciled",
    todos: "reconciled",
    goals: "derived",
    model: "partial",
    systemPrompt: "none",
    notes: [
      "Hooks expose no message text; Observer recovers both sides by tailing the session event log.",
      "Subagent transcripts are recovered too: subagent.started ties the log's agentId to the hook's agent name.",
      "Files attached to a turn are shown from the paths the session log records; Observer never copies the bytes.",
      "subagentStop carries the full final subagent response.",
      "The built-in general-purpose agent does not emit subagent events.",
      "preToolUse carries no tool call id, so repeated identical calls are merged.",
    ],
  },
}

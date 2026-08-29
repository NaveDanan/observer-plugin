import { useEffect, useMemo, useRef, useState } from "react"
import type {
  AgentEntity,
  HostCapabilities,
  MessageEntity,
  PromptFragmentEntity,
  TodoEntity,
  ToolCallEntity,
} from "@observer-ai/protocol"
import type { EmployeeMatch } from "@observer-ai/roster"
import { ChatMarkdown } from "./chat/ChatMarkdown"
import { Attachments } from "./chat/Attachments"
import { EMPTY_VOCABULARY, type InlineVocabulary } from "./chat/InlineVocabulary"
import { buildTimeline } from "./chat/timeline"
import { ToolRun } from "./chat/ToolRun"
import { Thought } from "./chat/Thought"
import { churnSummary, churnTitle } from "./churn"
import { useDismissLayer } from "./dismissLayer"
import { ProfileTab } from "./ProfileTab"

type Tab = "profile" | "chat" | "prompt" | "todos"

export interface DetailPanelProps {
  agent: AgentEntity
  match: EmployeeMatch | undefined
  messages: MessageEntity[]
  toolCalls: ToolCallEntity[]
  todos: TodoEntity[]
  promptFragments: PromptFragmentEntity[]
  capabilities: HostCapabilities | undefined
  onOpenCard: () => void
  onClose: () => void
}

/**
 * Profile leads because it answers "who am I looking at?", which is the first
 * question after clicking a node — but Chat is what the panel *opens* on,
 * because it is what the reader returns to. Order by question, default by
 * frequency.
 *
 * There is no Tools tab. Tool calls are interleaved into the transcript, where
 * a call sits next to the sentence that explains it; see `buildTimeline`.
 */
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "profile", label: "Profile" },
  { id: "chat", label: "Chat" },
  { id: "prompt", label: "Prompt" },
  { id: "todos", label: "Todos" },
]

/** An Agent that is still working, which is what the pulsing badge signals. */
function isLive(agent: AgentEntity): boolean {
  return agent.status === "running" || agent.status === "starting"
}

/**
 * The `+N -N` figure, or nothing at all.
 *
 * Returns `null` — not a zero — for an Agent the reducer never recorded an
 * edit for. See `churnSummary`, which owns that rule for every surface.
 *
 * The signs stay in the text so the colours are a second carrier rather than
 * the only one, and provenance rides along as the same `badge badge-soft` the
 * `Model` fact uses, so an inferred total is never presented as measured.
 */
function ChurnFigure({ agent }: { agent: AgentEntity }): JSX.Element | null {
  const churn = churnSummary(agent)
  if (!churn) return null
  return (
    <span className="churn" title={churnTitle(churn)}>
      {churn.added !== null && <span className="churn-added">{churn.added}</span>}
      {churn.removed !== null && <span className="churn-removed">{churn.removed}</span>}
      {churn.inferred && <span className="badge badge-soft">{churn.provenance}</span>}
    </span>
  )
}

export function DetailPanel(props: DetailPanelProps): JSX.Element {
  const { agent, match, messages, toolCalls, todos, promptFragments, capabilities, onOpenCard, onClose } = props
  const [tab, setTab] = useState<Tab>("chat")
  const closeRef = useRef<HTMLButtonElement>(null)
  const employee = match?.profile

  // Shared layer stack: when the ID card is open this panel sits underneath
  // it, and only the top layer answers Escape.
  useDismissLayer(onClose, { focusRef: closeRef })

  /**
   * What the transcript may highlight: this employee's skills, and the tools
   * this agent has actually called. Rebuilt only when either set changes, not
   * on every streamed token.
   */
  const vocabulary = useMemo<InlineVocabulary>(() => {
    const skills = new Map<string, string | undefined>()
    for (const skill of employee?.skills ?? []) skills.set(skill.name.toLowerCase(), skill.description)
    const tools = new Set(toolCalls.map((call) => call.tool.toLowerCase()))
    return skills.size === 0 && tools.size === 0 ? EMPTY_VOCABULARY : { skills, tools }
  }, [employee, toolCalls])

  return (
    <aside className="panel" role="dialog" aria-label={`Agent ${agent.displayName ?? agent.agentType}`}>
      <header className="panel-head">
        <div className="panel-id">
          <h2>{employee ? employee.fullName : (agent.displayName ?? agent.agentType)}</h2>
          <p className="panel-sub">
            <span className={`badge status-${agent.status}${isLive(agent) ? " badge-running" : ""}`}>
              {isLive(agent) && <span className="pulse-dot" aria-hidden="true" />}
              {agent.status}
            </span>
            <span className="mono">{agent.model ?? "model unknown"}</span>
            {agent.totalTokens ? <span className="muted">{agent.totalTokens.toLocaleString()} tokens</span> : null}
            <ChurnFigure agent={agent} />
          </p>
        </div>
        <button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            id={`detail-tab-${entry.id}`}
            aria-controls={`detail-tabpanel-${entry.id}`}
            aria-selected={tab === entry.id}
            className={tab === entry.id ? "tab is-active" : "tab"}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {entry.id === "chat" && messages.length > 0 && <span className="count">{messages.length}</span>}
            {entry.id === "todos" && todos.length > 0 && <span className="count">{todos.length}</span>}
          </button>
        ))}
      </nav>

      <div
        id={`detail-tabpanel-${tab}`}
        className="panel-body"
        role="tabpanel"
        aria-labelledby={`detail-tab-${tab}`}
        tabIndex={0}
      >
        {tab === "profile" && (
          <ProfileTab
            agent={agent}
            match={match}
            messages={messages}
            toolCalls={toolCalls}
            todos={todos}
            onOpenCard={onOpenCard}
          />
        )}
        {tab === "chat" && (
          <ChatTab
            messages={messages}
            toolCalls={toolCalls}
            agent={agent}
            capabilities={capabilities}
            vocabulary={vocabulary}
          />
        )}
        {tab === "prompt" && <PromptTab fragments={promptFragments} agent={agent} capabilities={capabilities} />}
        {tab === "todos" && <TodoTab todos={todos} agent={agent} capabilities={capabilities} />}
      </div>
    </aside>
  )
}

// --------------------------------------------------------------------- chat

const ROLE_LABEL: Record<MessageEntity["role"], string> = {
  user: "You",
  assistant: "Agent",
  reasoning: "Thinking",
}

/**
 * The agent's turn, as one transcript.
 *
 * User turns sit right, the agent's left, and the tool calls that happened
 * between two sentences sit inline between them — so "let me check the config"
 * is immediately followed by the four reads it produced, rather than by the
 * next sentence with the reads filed away in another tab.
 */
function ChatTab({
  messages,
  toolCalls,
  agent,
  capabilities,
  vocabulary,
}: {
  messages: MessageEntity[]
  toolCalls: ToolCallEntity[]
  agent: AgentEntity
  capabilities: HostCapabilities | undefined
  vocabulary: InlineVocabulary
}): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const rows = useMemo(() => buildTimeline(messages, toolCalls), [messages, toolCalls])
  const last = messages[messages.length - 1]

  useEffect(() => {
    if (!pinned.current) return
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [last?.id, last?.text, rows.length])

  const note =
    capabilities?.liveAssistantText === "none"
      ? "This host exposes no live reply text; messages are recovered from its session log."
      : capabilities?.liveAssistantText === "batched"
        ? "Replies arrive line by line, not token by token."
        : capabilities?.liveAssistantText === "final-only"
          ? "Replies appear once the turn finishes."
          : undefined

  return (
    <div
      className="chat"
      ref={scroller}
      onScroll={(event) => {
        const el = event.currentTarget
        // Only auto-scroll when the reader is already at the bottom. Expanding
        // a tool call mid-thread must not yank them back down.
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
      }}
    >
      {rows.length === 0 ? (
        <EmptyChat agent={agent} capabilities={capabilities} />
      ) : (
        <>
          {note && <p className="chat-note">{note}</p>}
          <ol className="thread">
            {rows.map((row) =>
              row.kind === "tools" ? (
                <ToolRun
                  key={row.id}
                  calls={row.calls}
                  action={row.action}
                  summary={row.summary}
                  failed={row.failed}
                  running={row.running}
                />
              ) : row.message.role === "reasoning" ? (
                <Thought key={row.id} message={row.message} vocabulary={vocabulary} />
              ) : (
                <li key={row.id} className={`msg is-${row.message.role}${row.grouped ? " is-grouped" : ""}`}>
                  {!row.grouped && (
                    <div className="msg-meta">
                      <span className="msg-role">{ROLE_LABEL[row.message.role]}</span>
                      <time dateTime={new Date(row.message.createdAt).toISOString()}>
                        {new Date(row.message.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                  )}
                  <div className="msg-body">
                    <ChatMarkdown
                      text={row.message.text}
                      vocabulary={vocabulary}
                      streaming={row.message.streaming}
                    />
                    {row.message.attachments && <Attachments attachments={row.message.attachments} />}
                    {row.message.streaming && <span className="cursor" aria-label="still writing" />}
                  </div>
                </li>
              ),
            )}
          </ol>
        </>
      )}
    </div>
  )
}

/** Explains *why* a thread is empty instead of leaving a dead end. */
function EmptyChat({
  agent,
  capabilities,
}: {
  agent: AgentEntity
  capabilities: HostCapabilities | undefined
}): JSX.Element {
  const running = agent.status === "running" || agent.status === "starting"
  const reason =
    capabilities?.liveAssistantText === "final-only"
      ? `${capabilities.label} only reports a reply once the turn ends, so nothing appears until then.`
      : capabilities?.liveAssistantText === "none"
        ? `${capabilities.label} exposes no reply text through hooks. Observer recovers it from the session log, which can lag by a second.`
        : running
          ? "This agent has not produced any text yet."
          : "No messages were captured for this agent."
  return (
    <div className="empty">
      <p className="empty-title">{running ? "Waiting for the first message" : "No conversation captured"}</p>
      <p className="muted small">{reason}</p>
    </div>
  )
}

// ------------------------------------------------------------------- prompt

function PromptTab({
  fragments,
  agent,
  capabilities,
}: {
  fragments: PromptFragmentEntity[]
  agent: AgentEntity
  capabilities: HostCapabilities | undefined
}): JSX.Element {
  const systemNote =
    capabilities?.systemPrompt === "none"
      ? `${capabilities.label} does not expose any part of the effective system prompt.`
      : capabilities?.systemPrompt === "config-only"
        ? `${capabilities.label} exposes configured instructions only, not the composed system prompt.`
        : "Only the parts the host exposes are shown; the vendor base prompt is not included."

  return (
    <div className="stack">
      <section className="block">
        <h3>Agent</h3>
        <dl className="facts">
          <dt>Type</dt>
          <dd>{agent.agentType}</dd>
          <dt>Status</dt>
          <dd>{agent.status}</dd>
          <dt>Model</dt>
          <dd className="mono">
            {agent.model ?? "unknown"}
            {agent.modelConfidence && agent.modelConfidence !== "authoritative" && (
              <span className="badge badge-soft">{agent.modelConfidence}</span>
            )}
          </dd>
          {agent.description && (
            <>
              <dt>Task</dt>
              <dd>{agent.description}</dd>
            </>
          )}
          {/* Absent, not zero: an Agent that only read files has no churn row
              at all rather than a `+0 -0` claiming a measurement we never
              made. `ChurnFigure` returns null and this row disappears with it. */}
          {churnSummary(agent) && (
            <>
              <dt>Code churn</dt>
              <dd>
                <ChurnFigure agent={agent} />
              </dd>
            </>
          )}
        </dl>
      </section>

      <p className="notice">{systemNote}</p>

      {fragments.map((fragment) => (
        <section key={fragment.id} className="block">
          <h3>
            {fragment.label}
            <span className={`badge availability-${fragment.availability}`}>{fragment.availability}</span>
          </h3>
          {fragment.path && <p className="mono muted small">{fragment.path}</p>}
          {fragment.note && <p className="muted small">{fragment.note}</p>}
          {fragment.text ? <pre className="pre">{fragment.text}</pre> : <p className="muted">Content not captured.</p>}
        </section>
      ))}

      {fragments.length === 0 && (
        <p className="muted small">
          No prompt fragments captured yet. Instruction files and delegated tasks appear here as the host reports them.
        </p>
      )}
    </div>
  )
}

// -------------------------------------------------------------------- todos

function TodoTab({
  todos,
  agent,
  capabilities,
}: {
  todos: TodoEntity[]
  agent: AgentEntity
  capabilities: HostCapabilities | undefined
}): JSX.Element {
  if (todos.length === 0) {
    const isChild = Boolean(agent.parentAgentId)
    return (
      <div className="stack">
        <div className="empty">
          <p className="empty-title">No task list</p>
          <p className="muted small">
            {isChild
              ? "Subagents usually work from the task they were given rather than keeping their own list."
              : capabilities?.todos === "reconciled"
                ? `${capabilities.label} reports todos through a tool call; none has run yet.`
                : "This agent has not created a task list."}
          </p>
        </div>
      </div>
    )
  }
  const done = todos.filter((todo) => todo.status === "completed").length
  return (
    <div className="stack">
      <p className="muted small">
        {done} of {todos.length} complete
      </p>
      <ol className="todos">
        {todos.map((todo) => (
          <li key={todo.id} className={`todo status-${todo.status}`}>
            <span className={`marker status-${todo.status}`} aria-hidden="true" />
            <span className="todo-text">{todo.content}</span>
            <span
              className="badge badge-soft"
              title={todo.originalStatus ? `Host status: ${todo.originalStatus}` : undefined}
            >
              {todo.originalStatus ?? todo.status}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

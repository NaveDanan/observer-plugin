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

type Tab = "prompt" | "chat" | "todos" | "tools"

export interface DetailPanelProps {
  agent: AgentEntity
  match: EmployeeMatch | undefined
  messages: MessageEntity[]
  toolCalls: ToolCallEntity[]
  todos: TodoEntity[]
  promptFragments: PromptFragmentEntity[]
  capabilities: HostCapabilities | undefined
  onClose: () => void
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "prompt", label: "Prompt" },
  { id: "chat", label: "Chat" },
  { id: "todos", label: "Todos" },
  { id: "tools", label: "Tools" },
]

export function DetailPanel(props: DetailPanelProps): JSX.Element {
  const { agent, match, messages, toolCalls, todos, promptFragments, capabilities, onClose } = props
  const [tab, setTab] = useState<Tab>("chat")
  const closeRef = useRef<HTMLButtonElement>(null)
  const employee = match?.profile

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <aside className="panel" role="dialog" aria-label={`Agent ${agent.displayName ?? agent.agentType}`}>
      <header className="panel-head">
        <div className="panel-id">
          <h2>{employee ? `${employee.fullName} — activity` : (agent.displayName ?? agent.agentType)}</h2>
          <p className="panel-sub">
            <span className={`badge status-${agent.status}`}>{agent.status}</span>
            <span className="mono">{agent.model ?? "model unknown"}</span>
            {agent.totalTokens ? <span className="muted">{agent.totalTokens.toLocaleString()} tokens</span> : null}
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
            aria-selected={tab === entry.id}
            className={tab === entry.id ? "tab is-active" : "tab"}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {entry.id === "chat" && messages.length > 0 && <span className="count">{messages.length}</span>}
            {entry.id === "todos" && todos.length > 0 && <span className="count">{todos.length}</span>}
            {entry.id === "tools" && toolCalls.length > 0 && <span className="count">{toolCalls.length}</span>}
          </button>
        ))}
      </nav>

      <div className="panel-body">
        {tab === "prompt" && <PromptTab fragments={promptFragments} agent={agent} capabilities={capabilities} />}
        {tab === "chat" && <ChatTab messages={messages} agent={agent} capabilities={capabilities} />}
        {tab === "todos" && <TodoTab todos={todos} agent={agent} capabilities={capabilities} />}
        {tab === "tools" && <ToolTab calls={toolCalls} />}
      </div>
    </aside>
  )
}

// --------------------------------------------------------------------- chat

/** Splits assistant text into prose and fenced code blocks. */
function splitFences(text: string): Array<{ type: "text" | "code"; body: string; lang?: string }> {
  const parts: Array<{ type: "text" | "code"; body: string; lang?: string }> = []
  const pattern = /```([\w+-]*)\n?([\s\S]*?)```/g
  let index = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > index) parts.push({ type: "text", body: text.slice(index, match.index) })
    parts.push({ type: "code", body: match[2] ?? "", lang: match[1] || undefined })
    index = match.index + match[0].length
  }
  if (index < text.length) parts.push({ type: "text", body: text.slice(index) })
  return parts.filter((part) => part.body.trim().length > 0 || part.type === "code")
}

function MessageBody({ text }: { text: string }): JSX.Element {
  const parts = useMemo(() => splitFences(text), [text])
  if (parts.length === 0) return <span />
  return (
    <>
      {parts.map((part, index) =>
        part.type === "code" ? (
          <pre key={index} className="msg-code">
            {part.lang && <span className="msg-code-lang">{part.lang}</span>}
            <code>{part.body.replace(/\n$/, "")}</code>
          </pre>
        ) : (
          <span key={index} className="msg-text">
            {part.body.replace(/^\n+|\n+$/g, "")}
          </span>
        ),
      )}
    </>
  )
}

const ROLE_LABEL: Record<MessageEntity["role"], string> = {
  user: "You",
  assistant: "Agent",
  reasoning: "Thinking",
}

/**
 * Renders the agent's conversation as a chat thread.
 *
 * User turns sit on the right, the agent's on the left, and consecutive turns
 * from the same speaker are grouped so a long reply reads as one continuous
 * message rather than a list of records.
 */
function ChatTab({
  messages,
  agent,
  capabilities,
}: {
  messages: MessageEntity[]
  agent: AgentEntity
  capabilities: HostCapabilities | undefined
}): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const last = messages[messages.length - 1]

  useEffect(() => {
    if (!pinned.current) return
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [last?.id, last?.text, messages.length])

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
        // Only auto-scroll when the reader is already at the bottom.
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
      }}
    >
      {messages.length === 0 ? (
        <EmptyChat agent={agent} capabilities={capabilities} />
      ) : (
        <>
          {note && <p className="chat-note">{note}</p>}
          <ol className="thread">
            {messages.map((message, index) => {
              const previous = messages[index - 1]
              const grouped = previous?.role === message.role && message.createdAt - previous.updatedAt < 120_000
              return (
                <li key={message.id} className={`msg is-${message.role}${grouped ? " is-grouped" : ""}`}>
                  {!grouped && (
                    <div className="msg-meta">
                      <span className="msg-role">{ROLE_LABEL[message.role]}</span>
                      <time dateTime={new Date(message.createdAt).toISOString()}>
                        {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </time>
                    </div>
                  )}
                  <div className="msg-body">
                    <MessageBody text={message.text} />
                    {message.streaming && <span className="cursor" aria-label="still writing" />}
                  </div>
                </li>
              )
            })}
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

// -------------------------------------------------------------------- tools

function ToolTab({ calls }: { calls: ToolCallEntity[] }): JSX.Element {
  const [openId, setOpenId] = useState<string | undefined>()
  const ordered = useMemo(() => [...calls].reverse(), [calls])

  if (calls.length === 0) {
    return (
      <div className="stack">
        <div className="empty">
          <p className="empty-title">No tool calls</p>
          <p className="muted small">This agent has not run a tool yet.</p>
        </div>
      </div>
    )
  }

  return (
    <ul className="tools">
      {ordered.map((call) => (
        <li key={call.id} className={`tool status-${call.status}`}>
          <button
            className="tool-head"
            onClick={() => setOpenId(openId === call.id ? undefined : call.id)}
            aria-expanded={openId === call.id}
          >
            <span className={`marker status-${call.status}`} aria-hidden="true" />
            <span className="mono">{call.tool}</span>
            {call.durationMs !== null && <span className="muted small">{call.durationMs}ms</span>}
          </button>
          {openId === call.id && (
            <div className="tool-body">
              {call.input !== null && call.input !== undefined && (
                <>
                  <h4>Input</h4>
                  <pre className="pre">{JSON.stringify(call.input, null, 2)}</pre>
                </>
              )}
              {call.output && (
                <>
                  <h4>Output</h4>
                  <pre className="pre">{call.output}</pre>
                </>
              )}
              {call.error && (
                <>
                  <h4>Error</h4>
                  <pre className="pre error">{call.error}</pre>
                </>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

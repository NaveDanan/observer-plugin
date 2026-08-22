import { Fragment, isValidElement, type ReactNode } from "react"
import { PackageIcon, WrenchIcon } from "lucide-react"

/**
 * The words this agent's transcript is allowed to light up.
 *
 * Highlighting is driven by what the session actually contains, not by a
 * pattern that looks plausible. `$deploy` is a chip when this employee holds a
 * `deploy` skill and plain text when they do not, and a backticked `bash` is a
 * tool chip only once a `bash` call has been recorded for this agent. Anything
 * else stays prose.
 *
 * The alternative — colouring every `$word` and every backticked token — turns
 * ordinary shell snippets (`$PATH`, `$1`) and ordinary nouns into false
 * positives, and a highlight that is wrong half the time trains the reader to
 * ignore it. Better to under-claim: an unmatched skill reads as normal text,
 * which is not a bug, just an absence of emphasis.
 */
export interface InlineVocabulary {
  /** Lower-cased skill name to its description, for the chip's tooltip. */
  skills: ReadonlyMap<string, string | undefined>
  /** Lower-cased names of tools this agent has actually called. */
  tools: ReadonlySet<string>
}

export const EMPTY_VOCABULARY: InlineVocabulary = { skills: new Map(), tools: new Set() }

/**
 * A `$name` reference.
 *
 * Anchored to a word boundary so `$PATH` inside a command and the `$` in
 * `US$40` cannot start a token, and lower-cased first so `$Deploy` matches a
 * `deploy` skill — skill names are identifiers, and the reader did not
 * necessarily type one exactly.
 */
const SKILL_TOKEN = /(^|[\s(["'])\$([a-zA-Z][\w:-]*)/g

/** A skill the roster knows about, or a tool this agent has run. */
export function SkillChip({ name, description }: { name: string; description?: string | undefined }): JSX.Element {
  return (
    <span className="inline-chip is-skill" title={description ?? `Skill: ${name}`}>
      <PackageIcon size={11} aria-hidden="true" />
      <span className="inline-chip-label">{name}</span>
    </span>
  )
}

export function ToolChip({ name }: { name: string }): JSX.Element {
  return (
    <span className="inline-chip is-tool" title={`Tool: ${name}`}>
      <WrenchIcon size={11} aria-hidden="true" />
      <span className="inline-chip-label">{name}</span>
    </span>
  )
}

/**
 * Splits one string into text and skill chips.
 *
 * Returns the original string unchanged when nothing matches, so the common
 * case allocates nothing and React keeps the existing text node rather than
 * replacing it with a single-element array on every render.
 */
export function renderSkillTokens(text: string, vocabulary: InlineVocabulary): ReactNode {
  if (vocabulary.skills.size === 0 || !text.includes("$")) return text

  const nodes: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  SKILL_TOKEN.lastIndex = 0

  while ((match = SKILL_TOKEN.exec(text)) !== null) {
    const [whole, lead = "", name = ""] = match
    const key = name.toLowerCase()
    if (!vocabulary.skills.has(key)) continue
    const start = match.index + lead.length
    if (start > cursor) nodes.push(text.slice(cursor, start))
    nodes.push(<SkillChip key={`${start}-${key}`} name={name} description={vocabulary.skills.get(key)} />)
    cursor = match.index + whole.length
  }

  if (nodes.length === 0) return text
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return <>{nodes}</>
}

/**
 * Walks rendered markdown children and swaps skill tokens for chips.
 *
 * Recurses into elements because inline markup nests — a skill named inside
 * bold or a list item is still a skill — but stops at `code` and `a`. Code is
 * quoted verbatim by definition, and a chip inside a link would nest an
 * interactive element inside another one, which is both invalid and a mess to
 * operate with a keyboard.
 */
export function renderInlineChildren(children: ReactNode, vocabulary: InlineVocabulary): ReactNode {
  if (vocabulary.skills.size === 0) return children
  return mapChildren(children, vocabulary)
}

function mapChildren(children: ReactNode, vocabulary: InlineVocabulary): ReactNode {
  if (typeof children === "string") return renderSkillTokens(children, vocabulary)
  if (Array.isArray(children)) {
    return children.map((child, index) => <Fragment key={index}>{mapChildren(child, vocabulary)}</Fragment>)
  }
  if (isValidElement(children)) {
    const type = children.type
    // `type` is the override component, not the intrinsic tag, once
    // react-markdown has substituted ours — so the hast node it passes down is
    // the only reliable way to ask what this element originally was.
    const node = (children.props as { node?: { tagName?: string } }).node
    const tag = typeof type === "string" ? type : node?.tagName
    if (tag === "code" || tag === "a" || tag === "pre") return children
    const inner = (children.props as { children?: ReactNode }).children
    if (inner === undefined) return children
    return { ...children, props: { ...children.props, children: mapChildren(inner, vocabulary) } }
  }
  return children
}

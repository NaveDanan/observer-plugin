import { memo, type ReactNode } from "react"
import type { Element, ElementContent } from "hast"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { CodeBlock } from "./CodeBlock"
import { EMPTY_VOCABULARY, renderInlineChildren, ToolChip, type InlineVocabulary } from "./InlineVocabulary"

/**
 * Markdown for agent and user messages.
 *
 * Raw HTML is **not** enabled. `react-markdown` escapes it by default, and
 * turning that off would mean rendering markup produced by a model — and, one
 * hop upstream, by whatever files and web pages that model read — inside the
 * operator's console. The features that would buy (a stray `<br>`, an inline
 * `<img>`) are not worth owning a sanitiser and the standing obligation to
 * keep it correct. Everything below therefore works on parsed markdown only.
 */

/**
 * Carries a fence's meta string (```` ```ts title="run.ts" ````) into the
 * rendered tree.
 *
 * The meta lives on the mdast `code` node and is dropped when mdast becomes
 * hast, so without this the filename is parsed and then thrown away one step
 * before anything can read it.
 */
interface MdastNode {
  type: string
  meta?: string | null
  data?: { hProperties?: Record<string, unknown> }
  children?: MdastNode[]
}

function remarkPreserveCodeMeta() {
  return (tree: MdastNode): void => {
    const visit = (node: MdastNode): void => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataCodeMeta: node.meta.trim() } }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}

const REMARK_PLUGINS = [remarkGfm, remarkPreserveCodeMeta]

/** `title="x.ts"`, `file=x.ts`, or a bare `path/to/x.ts` in the fence meta. */
const META_TITLE = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i
const META_BARE_FILENAME = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/

function filenameFromMeta(meta: string | undefined): string | undefined {
  if (!meta) return undefined
  const attribute = meta.match(META_TITLE)
  if (attribute) return attribute[1] ?? attribute[2] ?? attribute[3]
  const first = meta.split(/\s+/)[0]
  return first && META_BARE_FILENAME.test(first) ? first : undefined
}

const FENCE_LANGUAGE = /(?:^|\s)language-(\S+)/

/** Concatenates the text of a hast subtree — a fence's code, verbatim. */
function textOf(nodes: ElementContent[] | undefined): string {
  let out = ""
  for (const node of nodes ?? []) {
    if (node.type === "text") out += node.value
    else if (node.type === "element") out += textOf(node.children)
  }
  return out
}

export interface ChatMarkdownProps {
  text: string
  /** Which `$skills` and tool names may be chipped. */
  vocabulary?: InlineVocabulary
  /** True while the message is still arriving; suppresses highlight caching. */
  streaming?: boolean
  className?: string
}

function buildComponents(vocabulary: InlineVocabulary, streaming: boolean): Components {
  const inline = (children: ReactNode): ReactNode => renderInlineChildren(children, vocabulary)

  return {
    // Fenced code is intercepted at `pre`, not at `code`. Taking it here means
    // the `code` override below only ever sees inline code, so the two cases
    // never have to be told apart after the fact.
    pre({ node }) {
      const fence = node?.children.find(
        (child): child is Element => child.type === "element" && child.tagName === "code",
      )
      const className = String(fence?.properties?.["className"] ?? "")
      const meta = fence?.properties?.["dataCodeMeta"]
      const code = textOf(fence?.children).replace(/\n$/, "")
      return (
        <CodeBlock
          code={code}
          language={className.match(FENCE_LANGUAGE)?.[1]}
          filename={filenameFromMeta(typeof meta === "string" ? meta : undefined)}
          streaming={streaming}
        />
      )
    },

    // Inline code that names a tool this agent has run becomes a tool chip;
    // everything else stays literal.
    code({ children, ...rest }) {
      const literal = typeof children === "string" ? children : Array.isArray(children) ? children.join("") : ""
      if (vocabulary.tools.has(literal.trim().toLowerCase())) return <ToolChip name={literal.trim()} />
      return <code {...rest}>{children}</code>
    },

    p: ({ node: _node, children, ...rest }) => <p {...rest}>{inline(children)}</p>,
    li: ({ node: _node, children, ...rest }) => <li {...rest}>{inline(children)}</li>,
    td: ({ node: _node, children, ...rest }) => <td {...rest}>{inline(children)}</td>,

    // Every link opens away from the console and cannot reach back into it.
    // `noopener` is the load-bearing half — without it the opened page gets a
    // live `window.opener` handle to this document.
    a: ({ node: _node, children, ...rest }) => (
      <a {...rest} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ),

    // Tables are the one block that reliably overflows a 380px panel, so they
    // get their own scroll container rather than forcing the whole message to
    // scroll sideways.
    table: ({ node: _node, children, ...rest }) => (
      <div className="md-table-scroll">
        <table {...rest}>{children}</table>
      </div>
    ),
  }
}

/**
 * Memoized on `text`, which is the prop that changes on every streamed token.
 * Re-parsing a settled message because a sibling grew is the single most
 * expensive thing this component can be asked to do.
 */
export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  vocabulary = EMPTY_VOCABULARY,
  streaming = false,
  className,
}: ChatMarkdownProps): JSX.Element {
  return (
    <div className={className ? `md ${className}` : "md"}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={buildComponents(vocabulary, streaming)}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

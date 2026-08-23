import { useEffect, useState, type ReactNode } from "react"
import type { FileIconData } from "./fileIcons.generated"
import { baseName } from "./toolStep"

/**
 * The real file-type glyph for a path — TypeScript's blue square, React's
 * atom, the yellow braces of JSON.
 *
 * A generic page outline tells the reader nothing they cannot already see from
 * the file name, whereas a familiar language mark is legible at 14px and is
 * recognised before the text beside it is read. That is the whole argument for
 * carrying icon artwork at all.
 *
 * Two constraints shape how it is done:
 *
 * **Nothing is fetched.** Observer promises no outbound network calls
 * (docs/privacy.md), which rules out Iconify's runtime API and every icon CDN.
 * The artwork is extracted from the vscode-icons set at build time by
 * `scripts/build-file-icons.mjs` into `fileIcons.generated.ts`.
 *
 * **The artwork is loaded late.** That generated module is ~130 KB of SVG
 * paths, which has no business sitting in the entry chunk for a panel the
 * reader may never open. It is imported dynamically on first use, exactly as
 * the Shiki grammars are, and every mounted icon is woken when it lands. Until
 * then — and for any extension not in the table — the caller's fallback shows,
 * so a step row never collapses to an empty slot.
 */

type IconTables = typeof import("./fileIcons.generated")

let tables: IconTables | null = null
let pending: Promise<void> | null = null
const waiting = new Set<() => void>()

function load(): void {
  if (tables || pending) return
  pending = import("./fileIcons.generated")
    .then((module) => {
      tables = module
      for (const wake of [...waiting]) wake()
    })
    .catch(() => {
      // A missing chunk costs the reader an icon, not a transcript. Leave
      // `tables` null so every caller keeps rendering its fallback.
    })
}

/**
 * Exact names beat extensions: `package.json` is npm's mark, not JSON's, and
 * `.d.ts` is a declaration file rather than an ordinary `.ts`.
 */
function lookup(path: string): FileIconData | null {
  if (!tables) return null
  const name = baseName(path).toLowerCase()
  const byName = tables.ICON_BY_NAME[name]
  if (byName) return tables.FILE_ICONS[byName] ?? null

  const dotted = name.endsWith(".d.ts") ? "d.ts" : name.slice(name.lastIndexOf(".") + 1)
  if (!dotted || dotted === name) return null
  const byExtension = tables.ICON_BY_EXTENSION[dotted]
  return byExtension ? (tables.FILE_ICONS[byExtension] ?? null) : null
}

function useIconData(path: string | null): FileIconData | null {
  const [, bump] = useState(0)

  useEffect(() => {
    if (tables || path === null) return
    const wake = () => bump((n) => n + 1)
    waiting.add(wake)
    load()
    return () => {
      waiting.delete(wake)
    }
  }, [path])

  return path === null ? null : lookup(path)
}

export function FileIcon({
  path,
  className,
  fallback = null,
}: {
  path: string | null
  className?: string
  /** Shown while the chunk loads, and for file types with no artwork. */
  fallback?: ReactNode
}) {
  const data = useIconData(path)
  if (!data) return <>{fallback}</>
  return (
    <svg
      className={className}
      viewBox={data.viewBox}
      role="presentation"
      aria-hidden="true"
      // Build-time artwork from a vendored icon set — never session data.
      dangerouslySetInnerHTML={{ __html: data.body }}
    />
  )
}

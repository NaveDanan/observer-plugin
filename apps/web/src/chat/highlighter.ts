import { useEffect, useRef, useState } from "react"
import type { Highlighter } from "shiki"

/**
 * Syntax highlighting for fenced code in the chat transcript.
 *
 * Three decisions are worth stating, because each one is load-bearing:
 *
 * **Both themes are baked into one pass.** Shiki can emit a light colour and a
 * dark colour for the same token (`color:#x; --shiki-dark:#y`), which CSS then
 * picks between under `.dark`. So a theme flip is a repaint, not a
 * re-highlight: no async work, no flash, and no theme in the cache key — which
 * would otherwise halve the hit rate for a fact the reader can toggle freely.
 *
 * **Grammars load on demand.** The `shiki` entry point is a registry of
 * dynamic imports, not the grammars themselves; touching `bundledLanguages` to
 * test whether a language exists costs nothing, and Vite code-splits each
 * grammar that is actually asked for. A transcript full of TypeScript never
 * downloads the Haskell grammar.
 *
 * **Streaming blocks bypass the cache.** A fence that is still arriving is a
 * different string on every token, so caching it would evict everything else
 * within a few hundred milliseconds to store a value that is never read twice.
 */

/** Emitted for the light half; `--shiki-dark` carries the other. */
const LIGHT_THEME = "github-light"
const DARK_THEME = "github-dark"
/** What an unknown or absent language degrades to — never an error. */
const PLAIN_LANGUAGE = "text"

/**
 * Bounded so a long session cannot grow the cache without limit. Entries are
 * whole rendered documents, so the count is kept low and paired with a byte
 * ceiling: 200 one-line snippets and 200 thousand-line files are very
 * different amounts of memory for the same entry count.
 */
const MAX_CACHE_ENTRIES = 300
const MAX_CACHE_BYTES = 24 * 1024 * 1024

interface CacheEntry {
  html: string
  bytes: number
}

/** Insertion-ordered `Map` as an LRU: re-set on read to move to the back. */
const cache = new Map<string, CacheEntry>()
let cacheBytes = 0

function cacheGet(key: string): string | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  cache.delete(key)
  cache.set(key, entry)
  return entry.html
}

function cacheSet(key: string, html: string): void {
  if (cache.has(key)) return
  // UTF-16 code units, two bytes each. An estimate is enough — this bounds
  // memory, it does not account for it.
  const bytes = html.length * 2
  cache.set(key, { html, bytes })
  cacheBytes += bytes
  while ((cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) && cache.size > 1) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cacheBytes -= cache.get(oldest.value)?.bytes ?? 0
    cache.delete(oldest.value)
  }
}

/** FNV-1a. Not a checksum — just a cheap, well-spread key for identical code. */
function hash(text: string): string {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193)
  }
  return (value >>> 0).toString(36)
}

/**
 * Common fence tags that are not Shiki language ids.
 *
 * Deliberately short. This exists for tags a model actually writes, not as a
 * mirror of Shiki's own alias table — Shiki already resolves its aliases, and
 * duplicating them here would create a second list to keep in sync.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  gitignore: "ini",
  dockerfile: "docker",
  yml: "yaml",
  jsonc: "json",
  plaintext: PLAIN_LANGUAGE,
  txt: PLAIN_LANGUAGE,
  "": PLAIN_LANGUAGE,
}

let registry: Promise<Record<string, unknown>> | undefined

/** The language ids Shiki can load, fetched once. Grammars stay unloaded. */
async function knownLanguages(): Promise<Record<string, unknown>> {
  registry ??= import("shiki").then((module) => ({
    ...module.bundledLanguages,
    // Aliases resolve inside Shiki, so they are absent from the id map even
    // though `codeToHtml` accepts them.
    ...Object.fromEntries(
      Object.values(module.bundledLanguagesInfo).flatMap((info) => (info.aliases ?? []).map((alias) => [alias, true])),
    ),
  }))
  return registry
}

/**
 * The Shiki id for a fence tag, or `text` when there is no such grammar.
 *
 * Unknown tags fall back rather than throw: a model inventing a `pseudocode`
 * fence should produce readable monospace, not a blank block or an error.
 */
export async function resolveLanguage(raw: string | undefined): Promise<string> {
  const tag = (raw ?? "").trim().toLowerCase()
  const aliased = LANGUAGE_ALIASES[tag] ?? tag
  if (aliased === PLAIN_LANGUAGE) return PLAIN_LANGUAGE
  const languages = await knownLanguages()
  return Object.hasOwn(languages, aliased) ? aliased : PLAIN_LANGUAGE
}

let highlighter: Promise<Highlighter> | undefined
const loaded = new Set<string>([PLAIN_LANGUAGE])

/** The shared highlighter, created on first use and reused for the session. */
async function getHighlighter(): Promise<Highlighter> {
  highlighter ??= import("shiki").then((module) =>
    module.createHighlighter({ themes: [LIGHT_THEME, DARK_THEME], langs: [PLAIN_LANGUAGE] }),
  )
  return highlighter
}

/**
 * Renders `code` to themed HTML.
 *
 * Resolves to plain-text-highlighted HTML rather than rejecting when a grammar
 * fails to load, so a broken or half-published grammar costs colour, not the
 * message it appears in.
 */
export async function highlight(code: string, language: string): Promise<string> {
  const shiki = await getHighlighter()
  let lang = language
  if (!loaded.has(lang)) {
    try {
      await shiki.loadLanguage(lang as Parameters<Highlighter["loadLanguage"]>[0])
      loaded.add(lang)
    } catch {
      lang = PLAIN_LANGUAGE
    }
  }
  try {
    return shiki.codeToHtml(code, {
      lang,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      // Without this Shiki inlines one theme as the real `color` and treats the
      // other as the variant. `false` makes both a custom property, so neither
      // wins by default and the `.dark` rule alone decides.
      defaultColor: false,
      cssVariablePrefix: "--shiki-",
    })
  } catch {
    return shiki.codeToHtml(code, {
      lang: PLAIN_LANGUAGE,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
      cssVariablePrefix: "--shiki-",
    })
  }
}

/**
 * Highlighted HTML for a block, or `null` until it is ready.
 *
 * Returns a cached result on the *first* render rather than after an effect,
 * so re-reading a message that has already been highlighted paints coloured
 * immediately instead of flashing plain and then recolouring. Callers render
 * an unhighlighted `<pre>` for `null`, which is what a cold block, an
 * in-flight grammar and a hard failure all look like — identical, readable,
 * and never a spinner.
 */
export function useHighlighted(code: string, language: string | undefined, streaming: boolean): string | null {
  const key = `${hash(code)}:${code.length}:${language ?? ""}`
  const [html, setHtml] = useState<string | null>(() => (streaming ? null : (cacheGet(key) ?? null)))
  // Survives the code changing under a streaming block: each run invalidates
  // the last, so a slow early chunk cannot land after a fast later one.
  const run = useRef(0)

  useEffect(() => {
    const cached = streaming ? undefined : cacheGet(key)
    if (cached !== undefined) {
      setHtml(cached)
      return
    }
    const token = ++run.current
    let cancelled = false
    void (async () => {
      try {
        const lang = await resolveLanguage(language)
        const rendered = await highlight(code, lang)
        if (cancelled || token !== run.current) return
        if (!streaming) cacheSet(key, rendered)
        setHtml(rendered)
      } catch {
        // Colour is an enhancement. The caller's plain `<pre>` is the floor,
        // and reaching it silently is the correct outcome, not an error state.
        if (!cancelled && token === run.current) setHtml(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [key, code, language, streaming])

  return html
}

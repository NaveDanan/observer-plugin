/**
 * The settings search index.
 *
 * Hand-written rather than derived from the rendered tree: a search that only
 * finds what is currently mounted would miss every row on the two tabs you
 * are not looking at, which is precisely when search is useful. Each entry's
 * `id` is the DOM id of the row it jumps to — keep them in step with the
 * panels.
 */

import type { SettingsTab } from "./SettingsPage"

export interface SettingsSearchItem {
  id: string
  title: string
  tab: SettingsTab
  /** Extra words a user might search for that are not in the title. */
  keywords?: string
}

export const SETTINGS_SEARCH_INDEX: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "setting-employees",
    title: "Employees",
    tab: "employees",
    keywords: "roster seat persona subagent target host model opencode codex claude cursor grok",
  },
  {
    id: "setting-seat-control",
    title: "Seat control",
    tab: "employees",
    keywords: "model effort reasoning variant override agent consent",
  },
  { id: "setting-guidance", title: "Roster guidance", tab: "general", keywords: "opencode plugin directive" },
  { id: "setting-capture-messages", title: "Messages", tab: "general", keywords: "capture record chat" },
  { id: "setting-capture-reasoning", title: "Reasoning", tab: "general", keywords: "capture chain of thought" },
  { id: "setting-capture-tools", title: "Tool calls", tab: "general", keywords: "capture input output" },
  { id: "setting-capture-prompts", title: "Prompts", tab: "general", keywords: "capture system prompt" },
  { id: "setting-capture-raw", title: "Raw events", tab: "general", keywords: "capture payload debug" },
  { id: "setting-redaction", title: "Redaction", tab: "general", keywords: "privacy secrets truncate" },
  { id: "setting-retention", title: "Retention", tab: "general", keywords: "prune delete history days" },
  { id: "setting-appearance-mode", title: "Appearance", tab: "appearance", keywords: "light dark system mode" },
  { id: "setting-themes", title: "Themes", tab: "appearance", keywords: "palette colour theme library" },
  { id: "setting-glass-opacity", title: "Glass opacity", tab: "appearance", keywords: "transparency blur menus" },
  { id: "setting-typography", title: "Typography", tab: "appearance", keywords: "font family size interface mono" },
  { id: "setting-word-wrap", title: "Word wrap", tab: "appearance", keywords: "wrap lines code" },
  { id: "setting-providers", title: "Providers", tab: "providers", keywords: "opencode claude codex copilot host" },
]

export function searchSettings(query: string): ReadonlyArray<SettingsSearchItem> {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  return SETTINGS_SEARCH_INDEX.filter((item) => {
    const haystack = `${item.title} ${item.keywords ?? ""}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

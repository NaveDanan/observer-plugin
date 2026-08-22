/**
 * The settings page: a full-window surface with its own navigation, opened
 * from the gear in the topbar.
 *
 * A page rather than a modal, and laid out exactly like T3 Code's: a
 * searchable rail on the left, one scrolling column of sections on the right,
 * one route per tab. Settings are a place you go, not a dialog you dismiss —
 * the canvas keeps running behind it and the URL says where you are, so a
 * reload lands back on the same tab.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { BotIcon, PaletteIcon, SearchIcon, Settings2Icon, UsersIcon, XIcon } from "lucide-react"
import { AppearancePanel } from "./AppearancePanel"
import { EmployeesPanel } from "./EmployeesPanel"
import { GeneralPanel } from "./GeneralPanel"
import { ProvidersPanel } from "./ProvidersPanel"
import { SETTINGS_SEARCH_INDEX, searchSettings } from "./search"
import { Button, Input, Kbd, SettingsSearchTargetProvider } from "../ui/primitives"
import { cn } from "../lib/utils"

export type SettingsTab = "general" | "employees" | "providers" | "appearance"

/**
 * Employees sits second, directly under General.
 *
 * It earns its own tab rather than a section: a seat is now fourteen people
 * times five hosts times a variable stack of adapter-supplied options, and it
 * shared a scroll with five capture switches that answered yes or no. It sits
 * above Providers because a provider is the plumbing and an employee is the
 * thing the plumbing is for.
 */
const TABS: ReadonlyArray<{ id: SettingsTab; label: string; icon: typeof Settings2Icon }> = [
  { id: "general", label: "General", icon: Settings2Icon },
  { id: "employees", label: "Employees", icon: UsersIcon },
  { id: "appearance", label: "Appearance", icon: PaletteIcon },
  { id: "providers", label: "Providers", icon: BotIcon },
]

const TAB_LABELS: Record<SettingsTab, string> = {
  general: "General",
  employees: "Employees",
  providers: "Providers",
  appearance: "Appearance",
}

export function isSettingsTab(value: string): value is SettingsTab {
  return value === "general" || value === "employees" || value === "providers" || value === "appearance"
}

export function SettingsPage({
  tab,
  onTabChange,
  onClose,
}: {
  tab: SettingsTab
  onTabChange: (tab: SettingsTab) => void
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState("")
  const [activeResult, setActiveResult] = useState(0)
  /** The row a search jump is trying to reach, cleared once it has scrolled. */
  const [searchTargetId, setSearchTargetId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const results = useMemo(() => searchSettings(query), [query])
  const searching = query.trim().length > 0

  // "/" focuses search, Escape leaves the page — the two keys a settings
  // surface is expected to answer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (event.key === "Escape" && !typing && document.querySelector('[role="dialog"]') === null) {
        onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  const jumpTo = useCallback(
    (item: (typeof SETTINGS_SEARCH_INDEX)[number]) => {
      setQuery("")
      setActiveResult(0)
      onTabChange(item.tab)
      setSearchTargetId(item.id)
    },
    [onTabChange],
  )

  const clearTarget = useCallback(() => setSearchTargetId(null), [])

  return (
    <div className="fixed inset-0 z-30 flex bg-background text-foreground">
      <nav
        data-app-sidebar
        aria-label="Settings sections"
        className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      >
        <div className="flex flex-col gap-2 p-[var(--sidebar-content-inset)]">
          <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
            <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
            <Input
              ref={searchRef}
              unstyled
              type="search"
              value={query}
              placeholder="Search"
              aria-label="Search settings"
              className="min-w-0 flex-1 bg-transparent p-0 text-sm font-medium text-sidebar-foreground placeholder:text-sidebar-muted-foreground"
              onChange={(event) => {
                setQuery(event.currentTarget.value)
                setActiveResult(0)
              }}
              onKeyDown={(event) => {
                if (results.length === 0) return
                if (event.key === "ArrowDown") {
                  event.preventDefault()
                  setActiveResult((index) => (index + 1) % results.length)
                } else if (event.key === "ArrowUp") {
                  event.preventDefault()
                  setActiveResult((index) => (index - 1 + results.length) % results.length)
                } else if (event.key === "Enter") {
                  event.preventDefault()
                  const result = results[activeResult]
                  if (result) jumpTo(result)
                } else if (event.key === "Escape") {
                  event.preventDefault()
                  event.stopPropagation()
                  setQuery("")
                }
              }}
            />
            {searching ? (
              <Button
                size="icon-micro"
                variant="ghost"
                aria-label="Clear settings search"
                className="shrink-0 text-sidebar-muted-foreground"
                onClick={() => {
                  setQuery("")
                  searchRef.current?.focus()
                }}
              >
                <XIcon className="size-3" />
              </Button>
            ) : (
              <Kbd className="h-4 min-w-0 px-1.5">/</Kbd>
            )}
          </div>

          {searching && results.length === 0 ? (
            <p role="status" className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
              No settings found
            </p>
          ) : null}

          <ul className="flex flex-col gap-0.5">
            {searching
              ? results.map((item, index) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onMouseMove={() => setActiveResult(index)}
                      onClick={() => jumpTo(item)}
                      className={cn(
                        "flex w-full min-h-10 cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-sidebar-row-hover",
                        index === activeResult && "bg-sidebar-row-selected",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-sidebar-foreground">{item.title}</span>
                        <span className="block truncate text-[11px] text-sidebar-muted-foreground/75">
                          {TAB_LABELS[item.tab]}
                        </span>
                      </span>
                    </button>
                  </li>
                ))
              : TABS.map((entry) => {
                  const Icon = entry.icon
                  const active = entry.id === tab
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        aria-current={active ? "page" : undefined}
                        onClick={() => onTabChange(entry.id)}
                        className={cn(
                          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-sm font-medium text-sidebar-foreground outline-none hover:bg-sidebar-row-hover",
                          active && "bg-sidebar-row-selected",
                        )}
                      >
                        <Icon className="size-4 shrink-0 text-[var(--sidebar-icon-color)]" />
                        <span className="truncate">{entry.label}</span>
                      </button>
                    </li>
                  )
                })}
          </ul>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center justify-between gap-4 border-b border-border/70 px-4">
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
            <span className="text-muted-foreground">Settings</span>
            <span className="text-muted-foreground/60">/</span>
            <span className="font-medium text-foreground">{TAB_LABELS[tab]}</span>
          </nav>
          <Button size="sm" variant="outline" onClick={onClose}>
            <XIcon />
            Close
          </Button>
        </header>

        <SettingsSearchTargetProvider targetId={searchTargetId} onTargetHandled={clearTarget}>
          <div
            data-settings-page-scroll
            className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto [--topbar-scroll-fade-height:1.5rem]"
          >
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-12 px-2 py-8 sm:px-6">
              {tab === "general" ? <GeneralPanel /> : null}
              {tab === "employees" ? <EmployeesPanel /> : null}
              {tab === "appearance" ? <AppearancePanel /> : null}
              {tab === "providers" ? <ProvidersPanel /> : null}
            </div>
          </div>
        </SettingsSearchTargetProvider>
      </div>
    </div>
  )
}

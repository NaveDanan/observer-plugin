/**
 * The Providers tab: which coding-agent hosts Observer is watching.
 *
 * "Provider" here is a host the plugin has access to — OpenCode, Claude Code,
 * Codex, Copilot CLI — not a model vendor, and Observer holds no credential
 * for any of them. That is why this tab is thinner than the one it is ported
 * from: there is nothing to authenticate, so the only questions a card can
 * answer are "is this host being captured", "what does it let us see", and
 * "what should it be called".
 *
 * Live status and stored config arrive from two different places and refresh
 * on different schedules, so they are held separately and joined per row:
 * `getProviderStatus()` says what the daemon has seen, `useObserverConfig()`
 * says what the user asked for, and neither is allowed to block the other from
 * rendering.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { LoaderIcon, PlusIcon, RefreshCwIcon } from "lucide-react"
import * as api from "../api"
import type { ProviderHostStatus, ProviderInstanceConfig } from "../api"
import { useObserverConfig } from "./useConfig"
import { AddProviderInstanceDialog } from "./providers/AddProviderInstanceDialog"
import { ProviderInstanceCard } from "./providers/ProviderInstanceCard"
import { getDriverOption } from "./providers/driverMeta"
import { buildInstanceRows, formatRelativeTime, type ProviderInstances } from "./providers/instances"
import { Badge, Button, Dialog, SettingsRow, SettingsSection, Tooltip } from "../ui/primitives"

/**
 * A one-second heartbeat for the relative timestamps, paused while the tab is
 * hidden — a settings page in a background window has no one to lie to.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === "visible") setNow(Date.now())
    }
    const timer = window.setInterval(tick, 1_000)
    document.addEventListener("visibilitychange", tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", tick)
    }
  }, [])
  return now
}

export function ProvidersPanel(): JSX.Element {
  const { config, loading, error, saving, save, reload } = useObserverConfig()
  const now = useNow()
  const [hosts, setHosts] = useState<ProviderHostStatus[] | undefined>(undefined)
  const [statusError, setStatusError] = useState<string | undefined>(undefined)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [addOpen, setAddOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const result = await api.getProviderStatus()
      setHosts(result.hosts)
      setStatusError(undefined)
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCheckedAt(Date.now())
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const refresh = useCallback((): void => {
    if (refreshing) return
    setRefreshing(true)
    void Promise.all([loadStatus(), reload()]).finally(() => setRefreshing(false))
  }, [loadStatus, refreshing, reload])

  const providers: ProviderInstances | undefined = config?.providers
  const rows = useMemo(() => buildInstanceRows(providers), [providers])
  const statusById = useMemo(() => {
    const map = new Map<string, ProviderHostStatus>()
    for (const host of hosts ?? []) map.set(host.id, host)
    return map
  }, [hosts])

  /**
   * Every write sends the whole map: `PUT /v1/config` replaces `providers`
   * wholesale, so a patch containing one instance would delete the rest.
   * Implicit default slots are materialised here, on first touch.
   */
  const writeInstances = useCallback(
    (mutate: (current: ProviderInstances) => ProviderInstances): void => {
      const current: ProviderInstances = { ...(config?.providers ?? {}) }
      void save({ providers: mutate(current) })
    },
    [config?.providers, save],
  )

  const updateInstance = useCallback(
    (instanceId: string, next: ProviderInstanceConfig): void => {
      writeInstances((current) => ({ ...current, [instanceId]: next }))
    },
    [writeInstances],
  )

  const deleteInstance = useCallback(
    (instanceId: string): void => {
      writeInstances((current) => {
        const next = { ...current }
        delete next[instanceId]
        return next
      })
    },
    [writeInstances],
  )

  const enabledCount = rows.filter((row) => row.instance.enabled).length
  const capturedSessions = (hosts ?? []).reduce((total, host) => total + host.sessions, 0)
  const combinedError = error ?? statusError
  const pendingDeleteRow = rows.find((row) => row.instanceId === pendingDelete)
  const summary =
    loading && !config
      ? "Loading providers…"
      : `${enabledCount} of ${rows.length} enabled · ${capturedSessions} session${
          capturedSessions === 1 ? "" : "s"
        } captured`

  return (
    <>
      <SettingsSection
        title="Providers"
        headerAction={
          <div className="flex items-center gap-1.5">
            {checkedAt === null ? null : (
              <span className="text-[11px] text-muted-foreground/60">
                Checked <span className="font-mono tabular-nums">{formatRelativeTime(checkedAt, now)}</span>
              </span>
            )}
            <Tooltip label="Add provider instance">
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label="Add provider instance"
                onClick={() => setAddOpen(true)}
              >
                <PlusIcon className="size-3" />
              </Button>
            </Tooltip>
            <Tooltip label="Refresh provider status">
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label="Refresh provider status"
                disabled={refreshing}
                onClick={refresh}
              >
                {refreshing ? <LoaderIcon className="size-3 animate-spin" /> : <RefreshCwIcon className="size-3" />}
              </Button>
            </Tooltip>
          </div>
        }
      >
        <SettingsRow
          id="setting-providers"
          title="Watched hosts"
          description="A provider is a coding-agent host Observer has access to. Every host it ships an adapter for gets a card; add an instance when you run the same host under more than one label."
          status={summary}
        />

        {combinedError ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl px-3 py-3 sm:px-4">
            <Badge variant="error">Error</Badge>
            <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">{combinedError}</p>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                void reload()
                void loadStatus()
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {loading && !config
          ? [0, 1, 2, 3].map((key) => (
              <div key={key} className="px-3 py-3 sm:px-4">
                <div className="h-8 animate-pulse rounded-lg bg-muted/50" />
              </div>
            ))
          : rows.map((row) => (
              <ProviderInstanceCard
                key={row.instanceId}
                instanceId={row.instanceId}
                instance={row.instance}
                driverOption={getDriverOption(row.driver)}
                // Status is per host, not per instance: the daemon counts
                // sessions by `host`, so two Claude instances report the same
                // activity. Saying so is better than inventing a split.
                status={statusById.get(row.driver)}
                now={now}
                isExpanded={expanded[row.instanceId] ?? false}
                onExpandedChange={(open) => setExpanded((current) => ({ ...current, [row.instanceId]: open }))}
                onUpdate={(next) => updateInstance(row.instanceId, next)}
                {...(row.isDefault ? {} : { onDelete: () => setPendingDelete(row.instanceId) })}
              />
            ))}
      </SettingsSection>

      {/* Mounted only while open, so every visit starts the wizard at step one. */}
      {addOpen ? (
        <AddProviderInstanceDialog
          open
          providers={providers}
          saving={saving}
          onClose={() => setAddOpen(false)}
          onSubmit={(instanceId, instance) => {
            updateInstance(instanceId, instance)
            setExpanded((current) => ({ ...current, [instanceId]: true }))
            setAddOpen(false)
          }}
        />
      ) : null}
      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete provider instance"
        description={
          pendingDeleteRow
            ? `'${pendingDeleteRow.instanceId}' will be removed from ~/.observer/config.json. Sessions already captured from it are kept.`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={saving}
              onClick={() => {
                if (pendingDelete !== null) deleteInstance(pendingDelete)
                setPendingDelete(null)
              }}
            >
              Delete instance
            </Button>
          </>
        }
      />
    </>
  )
}

/**
 * One provider instance: a collapsed header that answers "is this host being
 * captured, and when did it last say anything", and an expanded body for the
 * two things a user can actually change plus an honest capability read-out.
 *
 * The anatomy is T3 Code's `ProviderInstanceCard` — icon chip with a status
 * dot, name, id chip, one summary line, chevron and switch on the right. What
 * is missing is deliberate: Observer holds no credentials, so there is no
 * environment table and no driver settings form to render here.
 */

import { useEffect, useRef, useState } from "react"
import { CheckIcon, ChevronDownIcon, CopyIcon, Trash2Icon } from "lucide-react"
import type { ProviderHostStatus, ProviderInstanceConfig } from "../../api"
import { Button, Collapsible, DraftInput, Switch, Tooltip } from "../../ui/primitives"
import { cn } from "../../lib/utils"
import { AccentColorPicker } from "./AccentColorPicker"
import { installCommand, type DriverOption } from "./driverMeta"
import { describeInstance, instanceTone, mergeInstance, normalizeAccentColor, type StatusTone } from "./instances"

const TONE_DOT: Record<StatusTone, string> = {
  active: "bg-success",
  idle: "bg-muted-foreground/40",
  disabled: "bg-muted-foreground/25",
}

const TONE_LABEL: Record<StatusTone, string> = {
  active: "Active",
  idle: "No activity seen",
  disabled: "Disabled",
}

/** Copies to the clipboard and reports it in place, since there is no toaster. */
function CopyCommandButton({ command, label }: { command: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
    }
  }, [])

  return (
    <Tooltip label={copied ? "Copied" : "Copy command"}>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={`Copy the ${label} install command`}
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(
            () => {
              setCopied(true)
              if (timeoutRef.current !== null) clearTimeout(timeoutRef.current)
              timeoutRef.current = setTimeout(() => setCopied(false), 1_500)
            },
            () => undefined,
          )
        }}
      >
        {copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      </Button>
    </Tooltip>
  )
}

export function ProviderInstanceCard({
  instanceId,
  instance,
  driverOption,
  status,
  now,
  isExpanded,
  onExpandedChange,
  onUpdate,
  onDelete,
}: {
  instanceId: string
  instance: ProviderInstanceConfig
  driverOption: DriverOption | undefined
  status: ProviderHostStatus | undefined
  now: number
  isExpanded: boolean
  onExpandedChange: (open: boolean) => void
  onUpdate: (next: ProviderInstanceConfig) => void
  /** Omitted for default slots: deleting one would only make it reappear. */
  onDelete?: () => void
}): JSX.Element {
  const displayName = instance.displayName?.trim() || driverOption?.label || instance.driver
  const accentColor = normalizeAccentColor(instance.accentColor)
  const tone = instanceTone(instance.enabled, status)
  const summary = describeInstance({ driver: instance.driver, status, now })
  const command = installCommand(instance.driver)
  const IconComponent = driverOption?.icon
  const bodyId = `provider-instance-${instanceId}-body`

  return (
    <div className="rounded-xl transition-colors hover:bg-muted/20">
      <div className="px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background">
                {IconComponent ? (
                  <IconComponent className="size-4 text-foreground/80" aria-hidden />
                ) : (
                  <span className="text-[10px] font-medium text-muted-foreground" aria-hidden>
                    {instance.driver.slice(0, 2).toUpperCase()}
                  </span>
                )}
                <span
                  aria-hidden
                  title={TONE_LABEL[tone]}
                  className={cn(
                    "pointer-events-none absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
                    TONE_DOT[tone],
                  )}
                />
                <span className="sr-only">{TONE_LABEL[tone]}</span>
              </span>
              <h3 className="truncate text-sm font-medium tracking-[-0.005em] text-foreground">{displayName}</h3>
              {instanceId !== instance.driver ? (
                <code className="truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
                  {instanceId}
                </code>
              ) : null}
              {accentColor ? (
                <span
                  aria-hidden
                  title={`Accent ${accentColor}`}
                  style={{ backgroundColor: accentColor }}
                  className="size-2 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/20"
                />
              ) : null}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-[13px] leading-[1.45] text-muted-foreground/80">
              {summary}
            </p>
          </div>
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              size="compact"
              variant="ghost-muted"
              aria-expanded={isExpanded}
              aria-label={`Toggle ${displayName} details`}
              onClick={() => onExpandedChange(!isExpanded)}
            >
              <ChevronDownIcon className={cn("size-3.5 transition-transform", isExpanded && "rotate-180")} />
            </Button>
            <Switch
              checked={instance.enabled}
              onCheckedChange={(checked) => onUpdate(mergeInstance(instance, { enabled: checked }))}
              aria-label={`Enable ${displayName}`}
            />
            {onDelete ? (
              <Tooltip label="Delete instance">
                <Button
                  size="icon-micro"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`Delete provider instance ${instanceId}`}
                  onClick={onDelete}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </div>

      <Collapsible open={isExpanded}>
        <div id={bodyId} className="space-y-5 px-3 pt-2 pb-4 sm:px-4">
          <div>
            <label htmlFor={`provider-instance-${instanceId}-display-name`} className="block">
              <span className="text-xs font-medium text-foreground">Display name</span>
              <DraftInput
                id={`provider-instance-${instanceId}-display-name`}
                className="mt-1.5"
                value={instance.displayName ?? ""}
                onCommit={(value) => onUpdate(mergeInstance(instance, { displayName: value }))}
                placeholder={driverOption?.label ?? "Instance label"}
                spellCheck={false}
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Optional label shown in the provider list.
              </span>
            </label>
          </div>

          <AccentColorPicker
            displayName={displayName}
            value={instance.accentColor}
            onCommit={(value) => onUpdate(mergeInstance(instance, { accentColor: value }))}
            description="Used to distinguish this instance in the provider list and on the canvas."
          />

          <div className="grid gap-2">
            <span className="text-xs font-medium text-foreground">Capabilities</span>
            {driverOption ? (
              <ul className="grid gap-1">
                {driverOption.notes.map((note) => (
                  <li key={note} className="flex gap-2 text-xs leading-[1.5] text-muted-foreground">
                    <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/50" />
                    <span className="min-w-0">{note}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                This instance names a driver (<code className="text-foreground">{instance.driver}</code>) that this
                build does not ship. Its configuration is kept, but Observer cannot capture from it.
              </p>
            )}
            <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{command}</code>
              <CopyCommandButton command={command} label={displayName} />
            </div>
            <span className="text-xs text-muted-foreground">
              Observer reads what the host already has. It never stores API keys or credentials.
            </span>
          </div>
        </div>
      </Collapsible>
    </div>
  )
}

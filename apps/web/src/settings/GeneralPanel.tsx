/**
 * The General tab: what Observer captures, how long it keeps it, and what it
 * tells the host about the roster.
 *
 * Employees and seat control used to live at the top of this file. They moved
 * to their own tab when a seat grew from "one model and one effort" into a
 * per-host target with adapter-supplied options — see
 * `settings/EmployeesPanel.tsx`. What is left here is the set of rows whose
 * answer is yes or no, plus two numbers.
 *
 * Every write goes through `patch`, which rebuilds the object it is sending
 * from the freshest config it can reach. `PUT /v1/config` replaces `capture`
 * and `redaction` wholesale, so a handler that closed over the config it
 * rendered with would silently revert whatever landed in between.
 */

import { useCallback, useEffect, useRef } from "react"
import { EyeIcon, ShieldIcon } from "lucide-react"
import type { CaptureConfig, ConfigPatch, ObserverConfigView } from "../api"
import { NumberField, SettingResetButton, SettingsRow, SettingsSection, Switch } from "../ui/primitives"
import { useObserverConfig } from "./useConfig"

/**
 * Mirrors `DEFAULT_CONFIG` in `apps/daemon/src/config.ts`, which is the
 * authority. Copied for one purpose — deciding whether a reset button has
 * anything to reset — so a drift here shows a spare button, never a wrong
 * value: the daemon re-validates everything this panel sends.
 */
const DEFAULT_CAPTURE: CaptureConfig = {
  messages: true,
  reasoning: false,
  toolInput: true,
  toolOutput: true,
  prompts: true,
  rawEvents: false,
}
const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_MAX_TEXT_LENGTH = 64_000
const DEFAULT_REDACTION_ENABLED = true
const DEFAULT_GUIDANCE = true

export function GeneralPanel(): JSX.Element {
  const { config, loading, error, save } = useObserverConfig()

  /**
   * The newest config any render has seen, readable from an event handler.
   *
   * Written in an effect rather than during render: React commits effects
   * before it dispatches the next user event, so the handler always reads the
   * snapshot the user was actually looking at, and a render that is thrown
   * away never gets to poison it.
   */
  const latest = useRef<ObserverConfigView | undefined>(config)
  useEffect(() => {
    latest.current = config
  }, [config])

  /** Sends a patch built from the latest config, never from this render's copy. */
  const patch = useCallback(
    (build: (current: ObserverConfigView) => ConfigPatch): void => {
      const current = latest.current
      if (current === undefined) return
      void save(build(current))
    },
    [save],
  )

  if (config === undefined) {
    return (
      <p role="status" className="px-4 py-12 text-center text-sm text-muted-foreground">
        {loading ? "Loading settings…" : (error ?? "Settings are unavailable: the daemon did not answer.")}
      </p>
    )
  }

  const setCapture = (key: keyof CaptureConfig, value: boolean): void =>
    patch((current) => ({ capture: { ...current.capture, [key]: value } }))

  return (
    <>
      {error !== undefined ? (
        <p role="alert" className="mx-3 rounded-lg bg-error-surface px-3 py-2 text-[13px] text-error-foreground sm:mx-4">
          {error}
        </p>
      ) : null}

      <SettingsSection title="Capture" icon={<EyeIcon className="size-4.5 text-muted-foreground" />}>
        <CaptureRow
          id="setting-capture-messages"
          title="Messages"
          description="What the agents said: prompts you sent and the text they sent back. Turning this off means message text is never written to disk, not that it is hidden — the canvas keeps its shape, and the transcript is simply not there."
          field="messages"
          capture={config.capture}
          onChange={setCapture}
        />
        <CaptureRow
          id="setting-capture-reasoning"
          title="Reasoning"
          description="Chain-of-thought blocks, as the host emits them. Off by default because raw reasoning is the most sensitive and least useful content to keep on disk: it is where a model thinks out loud about the secrets it was just shown. Off means it is never written to disk."
          field="reasoning"
          capture={config.capture}
          onChange={setCapture}
        />
        <SettingsRow
          id="setting-capture-tools"
          title="Tool calls"
          description="Arguments in, results out. Tool input carries file paths and command lines; tool output carries whatever the tool read, which is where a repository's contents end up. Either switch off means that half is never written to disk."
          resetAction={
            config.capture.toolInput !== DEFAULT_CAPTURE.toolInput ||
            config.capture.toolOutput !== DEFAULT_CAPTURE.toolOutput ? (
              <SettingResetButton
                label="tool capture"
                onClick={() =>
                  patch((current) => ({
                    capture: {
                      ...current.capture,
                      toolInput: DEFAULT_CAPTURE.toolInput,
                      toolOutput: DEFAULT_CAPTURE.toolOutput,
                    },
                  }))
                }
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                Input
                <Switch
                  checked={config.capture.toolInput}
                  aria-label="Capture tool input"
                  onCheckedChange={(checked) => setCapture("toolInput", checked)}
                />
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                Output
                <Switch
                  checked={config.capture.toolOutput}
                  aria-label="Capture tool output"
                  onCheckedChange={(checked) => setCapture("toolOutput", checked)}
                />
              </span>
            </div>
          }
        />
        <CaptureRow
          id="setting-capture-prompts"
          title="Prompts"
          description="System prompts and the behaviour directives Observer hands the host, stored per agent. Useful for answering why an employee behaved the way they did; off means they are never written to disk."
          field="prompts"
          capture={config.capture}
          onChange={setCapture}
        />
        <CaptureRow
          id="setting-capture-raw"
          title="Raw events"
          description="Every event payload exactly as the host sent it, kept beside the normalised copy. Off by default: it roughly doubles what a session costs on disk and it is only worth it while you are debugging an adapter."
          field="rawEvents"
          capture={config.capture}
          onChange={setCapture}
        />
      </SettingsSection>

      <SettingsSection title="Privacy and retention" icon={<ShieldIcon className="size-4.5 text-muted-foreground" />}>
        <SettingsRow
          id="setting-redaction"
          title="Redaction"
          description="Strips credential-shaped strings out of captured text before it is stored, and truncates anything longer than the limit below. It runs on the way in, so what it removes was never on disk in the first place."
          resetAction={
            config.redaction.enabled !== DEFAULT_REDACTION_ENABLED ? (
              <SettingResetButton
                label="redaction"
                onClick={() =>
                  patch((current) => ({
                    redaction: { ...current.redaction, enabled: DEFAULT_REDACTION_ENABLED },
                  }))
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={config.redaction.enabled}
              aria-label="Redaction"
              onCheckedChange={(checked) =>
                patch((current) => ({ redaction: { ...current.redaction, enabled: checked } }))
              }
            />
          }
        />
        {config.redaction.enabled ? (
          <SettingsRow
            title="Maximum text length"
            description="Longer captured text is cut at this many characters. A transcript is evidence, not a backup: the tail of a 40,000-line file read is rarely what you came back for."
            resetAction={
              config.redaction.maxTextLength !== DEFAULT_MAX_TEXT_LENGTH ? (
                <SettingResetButton
                  label="maximum text length"
                  onClick={() =>
                    patch((current) => ({
                      redaction: { ...current.redaction, maxTextLength: DEFAULT_MAX_TEXT_LENGTH },
                    }))
                  }
                />
              ) : null
            }
            control={
              <NumberField
                value={config.redaction.maxTextLength}
                min={0}
                max={1_000_000}
                step={1000}
                suffix="characters"
                ariaLabel="Maximum text length"
                onValueChange={(value) =>
                  patch((current) => ({ redaction: { ...current.redaction, maxTextLength: value } }))
                }
              />
            }
          />
        ) : null}

        <SettingsRow
          id="setting-retention"
          title="Retention"
          description="Sessions older than this are deleted on the daemon's maintenance sweep, so a change here takes effect on the next sweep rather than the moment you set it. Zero keeps everything, forever."
          resetAction={
            config.retentionDays !== DEFAULT_RETENTION_DAYS ? (
              <SettingResetButton
                label="retention"
                onClick={() => patch(() => ({ retentionDays: DEFAULT_RETENTION_DAYS }))}
              />
            ) : null
          }
          control={
            <NumberField
              value={config.retentionDays}
              min={0}
              max={3650}
              suffix={config.retentionDays === 0 ? "days — keep everything" : "days"}
              ariaLabel="Retention in days"
              onValueChange={(value) => patch(() => ({ retentionDays: value }))}
            />
          }
        />

        <SettingsRow
          id="setting-guidance"
          title="Roster guidance"
          description="Whether the OpenCode plugin adds an extra roster briefing to the root agent. Native employee agents remain available on installed harnesses either way."
          resetAction={
            config.guidance !== DEFAULT_GUIDANCE ? (
              <SettingResetButton label="roster guidance" onClick={() => patch(() => ({ guidance: DEFAULT_GUIDANCE }))} />
            ) : null
          }
          control={
            <Switch
              checked={config.guidance}
              aria-label="Roster guidance"
              onCheckedChange={(checked) => patch(() => ({ guidance: checked }))}
            />
          }
        />
      </SettingsSection>

    </>
  )
}

function CaptureRow({
  id,
  title,
  description,
  field,
  capture,
  onChange,
}: {
  id: string
  title: string
  description: string
  field: keyof CaptureConfig
  capture: CaptureConfig
  onChange: (field: keyof CaptureConfig, value: boolean) => void
}): JSX.Element {
  return (
    <SettingsRow
      id={id}
      title={title}
      description={description}
      resetAction={
        capture[field] !== DEFAULT_CAPTURE[field] ? (
          <SettingResetButton label={title.toLowerCase()} onClick={() => onChange(field, DEFAULT_CAPTURE[field])} />
        ) : null
      }
      control={
        <Switch
          checked={capture[field]}
          aria-label={`Capture ${title.toLowerCase()}`}
          onCheckedChange={(checked) => onChange(field, checked)}
        />
      }
    />
  )
}

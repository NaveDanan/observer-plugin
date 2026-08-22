/**
 * The add-instance wizard: driver, then identity, then a look at what is about
 * to be written.
 *
 * Three steps for four fields is more ceremony than the form needs, and that
 * is the point — an instance id is a routing key that other surfaces will
 * remember, so the wizard makes choosing one a deliberate act and refuses to
 * move past it while it is invalid. Ported step-for-step from T3 Code's
 * `AddProviderInstanceDialog`.
 */

import { useMemo, useState } from "react"
import { CheckIcon } from "lucide-react"
import type { ProviderInstanceConfig } from "../../api"
import { Badge, Button, Dialog, Input } from "../../ui/primitives"
import { cn } from "../../lib/utils"
import { AccentColorPicker } from "./AccentColorPicker"
import { DRIVER_OPTIONS } from "./driverMeta"
import {
  deriveInstanceId,
  normalizeAccentColor,
  takenInstanceIds,
  validateInstanceId,
  type ProviderInstances,
} from "./instances"

const WIZARD_STEPS = ["Driver", "Identity", "Review"] as const
const IDENTITY_STEP = 1
const DEFAULT_DRIVER = DRIVER_OPTIONS[0]?.id ?? "opencode"

type WizardNavigation = { kind: "navigate"; step: number } | { kind: "blocked"; step: number }

/**
 * Forward motion past Identity needs a usable id, whether the user pressed
 * Next or jumped from a step chip; a blocked jump lands on Identity so the
 * inline error it already renders is the thing they see. Going back is never
 * blocked — nothing is written until the last step.
 */
function resolveWizardNavigation(
  currentStep: number,
  requestedStep: number,
  instanceIdError: string | null,
): WizardNavigation {
  const lastStep = WIZARD_STEPS.length - 1
  const targetStep = Math.max(0, Math.min(lastStep, requestedStep))
  const movesPastIdentity = currentStep <= IDENTITY_STEP && targetStep > IDENTITY_STEP
  if (movesPastIdentity && instanceIdError !== null) return { kind: "blocked", step: IDENTITY_STEP }
  return { kind: "navigate", step: targetStep }
}

export function AddProviderInstanceDialog({
  open,
  providers,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean
  providers: ProviderInstances | undefined
  saving: boolean
  onClose: () => void
  onSubmit: (instanceId: string, instance: ProviderInstanceConfig) => void
}): JSX.Element {
  const [step, setStep] = useState(0)
  const [driver, setDriver] = useState(DEFAULT_DRIVER)
  const [label, setLabel] = useState("")
  const [accentColor, setAccentColor] = useState("")
  const [instanceIdOverride, setInstanceIdOverride] = useState<string | null>(null)
  // Errors stay quiet until the first attempt to move on, then track live so
  // fixing the id clears the message where it stands.
  const [attempted, setAttempted] = useState(false)

  const taken = useMemo(() => takenInstanceIds(providers), [providers])
  const driverOption = DRIVER_OPTIONS.find((option) => option.id === driver) ?? DRIVER_OPTIONS[0]
  const instanceId = instanceIdOverride ?? deriveInstanceId(driver, label)
  const instanceIdError = validateInstanceId(instanceId, taken)
  const showInstanceIdError = attempted && instanceIdError !== null
  const displayName = label.trim() || driverOption?.label || driver

  const navigate = (requested: number): void => {
    const navigation = resolveWizardNavigation(step, requested, instanceIdError)
    if (navigation.kind === "blocked") setAttempted(true)
    setStep(navigation.step)
  }

  const submit = (): void => {
    setAttempted(true)
    if (instanceIdError !== null) return
    const normalizedAccent = normalizeAccentColor(accentColor)
    onSubmit(instanceId, {
      driver,
      enabled: true,
      ...(label.trim() ? { displayName: label.trim() } : {}),
      ...(normalizedAccent ? { accentColor: normalizedAccent } : {}),
    })
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add provider instance"
      description="Add another instance of a host Observer can watch — for example a second Claude Code install you run from a different machine account."
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (step === 0) {
                onClose()
                return
              }
              setStep((current) => Math.max(0, current - 1))
            }}
          >
            {step === 0 ? "Cancel" : "Back"}
          </Button>
          {step < WIZARD_STEPS.length - 1 ? (
            <Button size="sm" onClick={() => navigate(step + 1)}>
              Next
            </Button>
          ) : (
            <Button size="sm" disabled={saving} onClick={submit}>
              Add instance
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <ol
          role="list"
          className="grid grid-cols-3 gap-1 rounded-xl bg-muted/40 p-1 ring-1 ring-black/5 dark:ring-white/5"
        >
          {WIZARD_STEPS.map((name, index) => (
            <li key={name} className="min-w-0">
              <button
                type="button"
                aria-current={index === step ? "step" : undefined}
                aria-label={`${name}, step ${index + 1} of ${WIZARD_STEPS.length}`}
                onClick={() => navigate(index)}
                className={cn(
                  "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring max-sm:justify-center max-sm:px-2",
                  index === step && "bg-card ring-1 ring-black/5 hover:bg-card dark:ring-white/5",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full text-xs font-medium ring-1",
                    index < step
                      ? "bg-primary text-primary-foreground ring-primary"
                      : index === step
                        ? "bg-primary/10 text-primary ring-primary/30"
                        : "bg-card text-muted-foreground ring-black/10 dark:bg-white/5 dark:ring-white/10",
                  )}
                >
                  {index < step ? <CheckIcon className="size-3.5" /> : index + 1}
                </span>
                <span
                  className={cn(
                    "min-w-0 truncate text-sm font-medium max-sm:hidden",
                    index === step ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {name}
                </span>
              </button>
            </li>
          ))}
        </ol>

        <div className={cn("grid gap-2", step !== 0 && "hidden")}>
          <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
            Driver
          </div>
          <div
            role="radiogroup"
            aria-labelledby="add-instance-driver-label"
            className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          >
            {DRIVER_OPTIONS.map((option, index) => {
              const checked = option.id === driver
              const IconComponent = option.icon
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  // One tab stop for the group, arrows to move within it: the
                  // radio pattern every screen reader user expects.
                  tabIndex={checked ? 0 : -1}
                  data-checked={checked ? "" : undefined}
                  onClick={() => setDriver(option.id)}
                  onKeyDown={(event) => {
                    const delta =
                      event.key === "ArrowDown" || event.key === "ArrowRight"
                        ? 1
                        : event.key === "ArrowUp" || event.key === "ArrowLeft"
                          ? -1
                          : 0
                    if (delta === 0) return
                    event.preventDefault()
                    const nextIndex = (index + delta + DRIVER_OPTIONS.length) % DRIVER_OPTIONS.length
                    const next = DRIVER_OPTIONS[nextIndex]
                    if (!next) return
                    setDriver(next.id)
                    const target = event.currentTarget.parentElement?.querySelectorAll("[role='radio']")[nextIndex]
                    if (target instanceof HTMLElement) target.focus()
                  }}
                  className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary dark:ring-white/5 dark:data-checked:bg-primary/15"
                >
                  <IconComponent className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{option.label}</span>
                  {checked ? (
                    <span
                      aria-hidden
                      className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                    >
                      <CheckIcon className="size-3.5" />
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          <span className="text-[11px] text-muted-foreground">
            {driverOption?.installHint ?? "Pick the host this instance runs."}
          </span>
        </div>

        <label className={cn("grid gap-2", step !== IDENTITY_STEP && "hidden")}>
          <span className="text-xs font-medium text-foreground">Label</span>
          <Input
            className="bg-background"
            placeholder="e.g. Work"
            value={label}
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
          <span className="text-[11px] text-muted-foreground">Shown in the provider list. Optional.</span>
        </label>

        <label className={cn("grid gap-2", step !== IDENTITY_STEP && "hidden")}>
          <span className="text-xs font-medium text-foreground">Instance ID</span>
          <Input
            className="bg-background"
            placeholder={`${driver}_work`}
            value={instanceId}
            aria-invalid={showInstanceIdError}
            onChange={(event) => setInstanceIdOverride(event.currentTarget.value)}
          />
          {showInstanceIdError ? (
            <span className="text-[11px] text-destructive-foreground">{instanceIdError}</span>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              The key this instance is stored under. Letters, digits, '-', or '_'.
            </span>
          )}
        </label>

        <div className={cn(step !== IDENTITY_STEP && "hidden")}>
          <AccentColorPicker
            displayName={displayName}
            value={accentColor}
            onCommit={setAccentColor}
            commitDelayMs={0}
            description="Optional marker shown next to the instance."
          />
        </div>

        <div className={cn("grid gap-2", step !== WIZARD_STEPS.length - 1 && "hidden")}>
          <p className="text-sm text-muted-foreground">
            Observer will watch <span className="font-medium text-foreground">{driverOption?.label ?? driver}</span> as{" "}
            <span className="font-medium text-foreground">{displayName}</span>, stored under{" "}
            <code className="rounded bg-muted/60 px-1 py-0.5 text-[11px] text-foreground">{instanceId || "—"}</code>.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success" size="sm">
              Enabled
            </Badge>
            {normalizeAccentColor(accentColor) ? (
              <Badge variant="outline" size="sm">
                <span
                  aria-hidden
                  style={{ backgroundColor: normalizeAccentColor(accentColor) }}
                  className="size-2 rounded-full"
                />
                {normalizeAccentColor(accentColor)}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Nothing is installed by adding an instance. Run{" "}
            <code className="text-foreground">observer install {driver}</code> to wire the host up.
          </p>
        </div>
      </div>
    </Dialog>
  )
}

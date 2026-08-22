/**
 * One adapter descriptor, drawn.
 *
 * The whole of Observer's option rendering, and it is intentionally this small.
 * There are exactly two kinds of control because `ModelOptionDescriptor.type`
 * has exactly two values: a boolean is a switch, a select is a select. Nothing
 * in this file knows what `variant`, `reasoningEffort`, `contextWindow`,
 * `fastMode` or `thinking` *mean*, and that ignorance is the feature — it is
 * what makes five hosts with five different vocabularies one code path, and it
 * is what makes it impossible for this surface to offer a knob no adapter
 * described.
 *
 * There is no "reasoning effort" component anywhere in this folder. Reasoning
 * is not one global scale: OpenCode calls it `variant` and applies it only to
 * the agent's own model, Codex calls it `reasoningEffort` and has a separate
 * `serviceTier` beside it, Claude has `effort` alongside three unrelated
 * switches. A shared effort widget would have to pick one of those and be wrong
 * about the rest.
 */

import { Select, Switch } from "../../ui/primitives"
import type { ModelOptionDescriptor } from "../../api"
import { optionChoices, UNSET } from "./directory"

export function OptionField({
  descriptor,
  value,
  onChange,
}: {
  descriptor: ModelOptionDescriptor
  /** What the config holds today, or undefined for unset. */
  value: string | boolean | undefined
  /** `undefined` clears the option out of the target entirely. */
  onChange: (value: string | boolean | undefined) => void
}): JSX.Element {
  const hostDefault = descriptor.choices?.find((choice) => choice.isDefault === true)

  if (descriptor.type === "boolean") {
    return (
      <div className="flex items-start justify-between gap-4 py-1.5">
        <div className="min-w-0 space-y-0.5">
          <p className="text-[13px] font-medium text-foreground">{descriptor.label}</p>
          <p className="font-mono text-[11px] text-muted-foreground/70">{descriptor.id}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {value === undefined ? <span className="text-[11px] text-muted-foreground/70">unset</span> : null}
          <Switch
            checked={value === true}
            aria-label={descriptor.label}
            onCheckedChange={(checked) => onChange(checked)}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 space-y-0.5">
        <p className="text-[13px] font-medium text-foreground">{descriptor.label}</p>
        <p className="font-mono text-[11px] text-muted-foreground/70">
          {descriptor.id}
          {hostDefault !== undefined ? ` · unset means ${hostDefault.label}` : ""}
        </p>
      </div>
      <div className="w-full shrink-0 sm:w-56">
        <Select
          value={typeof value === "string" ? value : UNSET}
          options={optionChoices(descriptor, value)}
          ariaLabel={descriptor.label}
          placeholder="Unset"
          onValueChange={(next) => onChange(next === UNSET ? undefined : next)}
        />
      </div>
    </div>
  )
}

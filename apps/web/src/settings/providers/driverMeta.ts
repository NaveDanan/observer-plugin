/**
 * The presentation half of a host.
 *
 * Labels and capability notes are read straight out of `HOST_CAPABILITIES`
 * rather than copied here, because a provider card that disagrees with the
 * fidelity panel about what Claude Code can report is worse than no card at
 * all. What the protocol has no opinion on — an icon, and one line of "what
 * does installing this actually do to my machine" from
 * `integrations/README.md` — lives in this file.
 */

import { HOST_CAPABILITIES } from "@observer-ai/protocol"
import { BotIcon } from "lucide-react"
import { PROVIDER_ICON, type ProviderIcon } from "../../Icons"

/**
 * A provider's mark.
 *
 * Widened from `LucideIcon` so the real vendor marks can be used where they
 * exist. Both sides render as `<Icon className="size-4" />`, and Tailwind's
 * `size-*` beats the SVG's own `width`/`height` attributes, so the two kinds
 * are interchangeable at every call site.
 */
export type DriverIcon = ProviderIcon | typeof BotIcon

export interface DriverOption {
  /** The driver id, which is also the key of the host's default instance. */
  id: string
  label: string
  icon: DriverIcon
  /** One line of what `observer install <driver>` writes, for help text. */
  installHint: string
  notes: readonly string[]
}

/**
 * The vendors' own marks, shared with the session list so a host looks the
 * same everywhere it is named. `BotIcon` remains the fallback for a driver
 * this build has no artwork for — see `getDriverOption`.
 */
const DRIVER_ICONS: Partial<Record<string, DriverIcon>> = PROVIDER_ICON

const INSTALL_HINTS: Record<string, string> = {
  opencode: "Installs an in-process plugin at ~/.config/opencode/plugins/observer.js.",
  codex: "Writes hooks to ~/.codex/hooks.json, or ships a Codex plugin with --plugin.",
  claude: "Merges Observer's hooks into ~/.claude/settings.json.",
  copilot: "Owns ~/.copilot/hooks/observer.json, in both bash and PowerShell form.",
}

export const DRIVER_OPTIONS: ReadonlyArray<DriverOption> = Object.values(HOST_CAPABILITIES).map(
  (capability): DriverOption => ({
    id: capability.host,
    label: capability.label,
    icon: DRIVER_ICONS[capability.host] ?? BotIcon,
    installHint: INSTALL_HINTS[capability.host] ?? `Run observer install ${capability.host}.`,
    notes: capability.notes,
  }),
)

export const DRIVER_IDS: ReadonlyArray<string> = DRIVER_OPTIONS.map((option) => option.id)

/**
 * Returns `undefined` for a driver this build does not ship, so a card can
 * render the instance read-only instead of pretending to understand it. An
 * Observer config edited by hand can name anything.
 */
export function getDriverOption(driver: string): DriverOption | undefined {
  return DRIVER_OPTIONS.find((option) => option.id === driver)
}

/** The command that wires a host up, shown verbatim so it can be copied. */
export function installCommand(driver: string): string {
  return `observer install ${driver}`
}

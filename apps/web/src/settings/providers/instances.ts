/**
 * The row model behind the Providers tab, and the rules that keep the config
 * map honest.
 *
 * Every known driver always gets a card, even when nothing is written for it
 * yet: the alternative is an empty tab on a fresh install, which tells a user
 * nothing about which hosts Observer could watch. Those implicit cards are
 * materialised into `config.providers` only when the user touches one, so the
 * file on disk stays a record of decisions rather than a copy of the defaults.
 *
 * Kept free of React so the id rules and the summary copy can be exercised
 * without mounting a tree.
 */

import type { ProviderHostStatus, ProviderInstanceConfig } from "../../api"
import { DRIVER_IDS, getDriverOption } from "./driverMeta"

/** The six presets offered next to the colour input. User data, not tokens. */
export const ACCENT_SWATCHES: ReadonlyArray<string> = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
]

/**
 * Accepts what a colour input or a hand-edited config might hold and returns
 * a canonical `#rrggbb`, or `undefined` for "no accent". Anything unparseable
 * is dropped rather than rendered, because a broken colour would land in an
 * inline `style` and paint an invisible dot.
 */
export function normalizeAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase()
  if (!trimmed) return undefined
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(trimmed)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  return undefined
}

export interface InstanceRow {
  instanceId: string
  instance: ProviderInstanceConfig
  driver: string
  /** True for a driver's own slot, whose key is the driver id. */
  isDefault: boolean
  /** False while the slot is implicit — nothing is on disk for it yet. */
  isPersisted: boolean
}

export type ProviderInstances = Record<string, ProviderInstanceConfig>

/**
 * A default slot is enabled unless the user says otherwise: the plugin is
 * already watching whatever hosts are installed, and a card that reads
 * "disabled" before anyone has touched it would be a lie.
 */
export function defaultInstance(driver: string): ProviderInstanceConfig {
  return { driver, enabled: true }
}

/**
 * One card per known driver, then the user's own instances.
 *
 * A stored entry only claims a driver's default slot when its key and its
 * `driver` field agree; a hand-edited `{"claude": {"driver": "codex"}}` is
 * treated as a custom instance rather than silently retitling Claude's slot.
 */
export function buildInstanceRows(providers: ProviderInstances | undefined): InstanceRow[] {
  const entries = Object.entries(providers ?? {})
  const rows: InstanceRow[] = []

  for (const driver of DRIVER_IDS) {
    const stored = entries.find(([id, instance]) => id === driver && instance.driver === driver)
    rows.push({
      instanceId: driver,
      instance: stored ? stored[1] : defaultInstance(driver),
      driver,
      isDefault: true,
      isPersisted: stored !== undefined,
    })
  }

  const claimed = new Set(rows.filter((row) => row.isPersisted).map((row) => row.instanceId))
  for (const [id, instance] of entries) {
    if (claimed.has(id)) continue
    rows.push({
      instanceId: id,
      instance,
      driver: instance.driver,
      isDefault: false,
      isPersisted: true,
    })
  }

  return rows
}

/**
 * Applies an edit and returns the shape that goes on disk.
 *
 * Empty optional fields are dropped rather than stored as `""`: the config
 * file is read by humans, and `"displayName": ""` reads like a bug where an
 * absent key reads like a default.
 */
export function mergeInstance(
  instance: ProviderInstanceConfig,
  patch: Partial<ProviderInstanceConfig>,
): ProviderInstanceConfig {
  const merged = { ...instance, ...patch }
  const displayName = merged.displayName?.trim()
  const accentColor = normalizeAccentColor(merged.accentColor)
  return {
    driver: merged.driver,
    enabled: merged.enabled,
    ...(displayName ? { displayName } : {}),
    ...(accentColor ? { accentColor } : {}),
  }
}

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/
/**
 * Trimmed to 48 characters so the composed `{driver}_{slug}` id stays inside
 * the 64-character cap the daemon enforces.
 */
export function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
}

export function deriveInstanceId(driver: string, label: string): string {
  const slug = slugifyLabel(label)
  return slug ? `${driver}_${slug}` : ""
}

/** Returns the user-facing problem with an id, or `null` when it is usable. */
export function validateInstanceId(id: string, taken: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required."
  if (id.length > 64) return "Instance ID must be 64 characters or fewer."
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'."
  }
  if (taken.has(id)) return `An instance named '${id}' already exists.`
  return null
}

/** Existing keys plus the driver ids, which are reserved for default slots. */
export function takenInstanceIds(providers: ProviderInstances | undefined): ReadonlySet<string> {
  return new Set([...DRIVER_IDS, ...Object.keys(providers ?? {})])
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Coarse on purpose: "4m ago" is the answer, "4m 12s ago" is noise. */
export function formatRelativeTime(at: number, now: number): string {
  const elapsed = Math.max(0, now - at)
  if (elapsed < 45_000) return "just now"
  if (elapsed < HOUR) return `${Math.round(elapsed / MINUTE)}m ago`
  if (elapsed < DAY) return `${Math.round(elapsed / HOUR)}h ago`
  return `${Math.round(elapsed / DAY)}d ago`
}

export type StatusTone = "active" | "idle" | "disabled"

export function instanceTone(enabled: boolean, status: ProviderHostStatus | undefined): StatusTone {
  if (!enabled) return "disabled"
  return status && status.lastActiveAt !== null ? "active" : "idle"
}

/**
 * The one line under an instance's name.
 *
 * Ordered by what a user is actually asking the card: sessions first when
 * there are any, then whether Observer has been wired into the host at all,
 * and only then — when the daemon has told us nothing about this driver — the
 * host's own capability note, which at least says what the host can report.
 */
export function describeInstance(input: {
  driver: string
  status: ProviderHostStatus | undefined
  now: number
}): string {
  const { driver, now, status } = input
  const option = getDriverOption(driver)

  if (!status) {
    return option?.notes[0] ?? `Observer has no status for the '${driver}' driver.`
  }
  if (status.sessions > 0) {
    const sessions = `${status.sessions} session${status.sessions === 1 ? "" : "s"}`
    return status.lastActiveAt === null
      ? `${sessions} captured`
      : `${sessions} · last seen ${formatRelativeTime(status.lastActiveAt, now)}`
  }
  if (!status.configured) {
    return option ? `Not configured yet · ${option.installHint}` : "Not configured yet."
  }
  return "No sessions captured yet"
}

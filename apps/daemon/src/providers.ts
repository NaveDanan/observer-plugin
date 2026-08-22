import { z } from "zod"

/**
 * The coding agent tools Observer can be pointed at.
 *
 * A closed union because it is the switch every adapter is selected by, and an
 * open one would let a typo in `~/.observer/config.json` silently produce a
 * profile no adapter will ever claim. It is *not* enforced at parse time —
 * `driver` and `SeatTarget.host` both stay `string` so an unrecognised value
 * survives a save and is reported as a finding, the same way an unknown
 * employee id is. Rejecting it at the schema would delete the user's typo
 * before they could see it.
 *
 * Ordered as the roster tickets list them, not alphabetically; nothing reads
 * the order.
 */
export const HOST_KINDS = ["codex", "claude", "copilot", "cursor", "grok", "opencode"] as const

export type HostKind = (typeof HOST_KINDS)[number]

export function isHostKind(value: string): value is HostKind {
  return (HOST_KINDS as readonly string[]).includes(value)
}

/**
 * One configured host profile: which tool it drives, and where that tool lives.
 *
 * Keyed in `config.providers` by a user-chosen instance id, so the same host
 * can be configured twice — a work Codex and a personal one — with different
 * credentials on disk. That is why `binaryPath` and `homePath` are per
 * instance rather than global: they are the only two things that distinguish
 * two profiles of the same driver, and pinning them per instance is what stops
 * a second profile from silently reusing the first one's session and auth.
 */
export interface ProviderInstanceConfig {
  /**
   * A `HostKind` when Observer recognises it. See the note on `HOST_KINDS`.
   *
   * Empty when the file held something that was not a string. That is a value
   * to reject, not to act on: an empty driver names no adapter, and callers
   * already gate on it rather than trusting the type.
   */
  driver: string
  displayName?: string
  accentColor?: string
  /**
   * Executable to launch, when it is not the one on `PATH`.
   *
   * Absent means "resolve the driver's usual command name", which is what
   * almost every user wants. Naming it here is for the version-manager case
   * (nvm, mise, a vendored build) where the daemon's `PATH` is not the shell's
   * and an unqualified command name resolves to nothing.
   */
  binaryPath?: string
  /**
   * Config/state directory for this profile, when it is not the tool's
   * default. Absent means the tool's own default.
   */
  homePath?: string
  enabled: boolean
}

export const ProviderInstanceConfigSchema = z
  .object({
    // Field-level, like every other field here. It used to be the one required
    // field, so `{ driver: 42, displayName: "Local", binaryPath: "/x" }` fell
    // through to the object-level catch and came back `{}` — a mistyped driver
    // silently took the path the user had spent ten minutes finding. An empty
    // driver is a value a caller can see and refuse: `/v1/providers/status`
    // already filters on `driver.length > 0`.
    driver: z.string().min(1).catch(""),
    displayName: z.string().min(1).optional().catch(undefined),
    accentColor: z.string().min(1).optional().catch(undefined),
    // Paths are not checked for existence here. Diagnosis is a pure function
    // and the daemon may parse a config written on a different machine (or
    // before the tool is installed); a stat here would turn a portable config
    // into a parse failure. The adapter that launches the binary reports it.
    binaryPath: z.string().min(1).optional().catch(undefined),
    homePath: z.string().min(1).optional().catch(undefined),
    enabled: z.boolean().catch(true),
  })
  .passthrough()
  // Only a non-object can reach here now that every field catches, and the
  // answer is to hand it back untouched rather than to replace it with a shape
  // the user never wrote. Same bargain as a seat target: preserved on save,
  // and never trusted without a `typeof` guard.
  .catch((ctx) => ctx.input as { driver: string; enabled: boolean; [extra: string]: unknown })

export const ProvidersConfigSchema = z.record(z.string(), ProviderInstanceConfigSchema).catch({})

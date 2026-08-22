/**
 * What Observer will actually do with a target, in the vocabulary the research
 * uses and one sentence the user can act on.
 *
 * This module is the reason the Employees surface exists in the shape it does.
 * Every other settings row describes something Observer definitely does; a seat
 * target describes something Observer *might* do, on a host that might not let
 * it, behind a consent flag that is off by default. Five facts decide it:
 *
 *  1. has `/v1/hosts` answered yet,
 *  2. did it list this host at all,
 *  3. did the host's adapter manage to report `capabilities` — or is it `null`,
 *  4. what does it say about child control,
 *  5. is `seats.control` on.
 *
 * Fact three is the one that grew when the endpoints landed. The daemon returns
 * `capabilities: null` when an adapter throws, and it does that instead of
 * substituting a conservative all-`unsupported` block, because "no adapter
 * could answer" and "an adapter looked and the host cannot do it" are different
 * claims and only the second is a finding. Rendering the null as "no control"
 * would forge that finding. So there is a fifth verdict, `unknown`, and it says
 * out loud that Observer does not know.
 */

import { findHost } from "./directory"
import type { HostDirectory } from "./hosts"

/**
 * The five states.
 *
 *  - `applied`      — the adapter can steer a delegated child and consent is
 *                     given. Only OpenCode reaches this today.
 *  - `experimental` — the adapter has a prototyped path that fails open.
 *  - `configured`   — the adapter could apply this, but `seats.control` is off.
 *  - `unknown`      — nobody could tell us. A `null` capabilities block, a host
 *                     list that has not arrived, or one that failed to.
 *  - `inert`        — nothing is applied to a delegated child, because an
 *                     adapter looked and reported `unsupported`, or because no
 *                     adapter in this build claims the host.
 */
export type TargetControlStatus = "applied" | "experimental" | "configured" | "unknown" | "inert"

export interface ControlVerdict {
  status: TargetControlStatus
  /** Two or three words for a badge. */
  label: string
  /** Which `Badge` variant carries it. */
  tone: "success" | "warning" | "secondary" | "outline"
  /** One sentence, safe to render verbatim. */
  sentence: string
  /**
   * True where a change lands only after the host restarts.
   *
   * False when `capabilities` is null — not because a restart is unnecessary,
   * but because nobody said it was. The badge is a claim like any other and an
   * unknown host makes none.
   */
  requiresReload: boolean
  reloadSentence: string | undefined
  /** The daemon's own warnings for this host, rendered verbatim beneath. */
  warnings: readonly string[]
}

/**
 * The verdict for one target.
 *
 * Takes the whole directory rather than a resolved entry, because the three
 * ways an entry can be missing need three different sentences: the request is
 * in flight, the request failed, or the daemon genuinely does not have an
 * adapter for this host. A surface that showed the same words for all three
 * would tell a user with a slow daemon that Cursor is unsupported.
 *
 * `seatControl` is the master consent switch and it gates only the hosts that
 * could act on it. An `unsupported` host is inert whether the switch is on or
 * off, and saying "turn seat control on" beside it would send the user to flip
 * a switch that changes nothing for them — which is how a settings page trains
 * people to stop reading it.
 */
export function controlVerdict(directory: HostDirectory, host: string, seatControl: boolean): ControlVerdict {
  const entry = findHost(directory, host)

  if (entry === undefined) return missingEntry(directory, host)

  const capabilities = entry.capabilities
  if (capabilities === null) {
    return {
      status: "unknown",
      label: "control unknown",
      tone: "outline",
      sentence: `Observer could not read what ${entry.label} supports — its adapter failed to answer — so it makes no claim either way about this target. It is not that ${entry.label} cannot steer a delegated child; it is that nobody checked.`,
      requiresReload: false,
      reloadSentence: undefined,
      warnings: entry.warnings,
    }
  }

  const reload = capabilities.requiresReload ? reloadNote(entry.label) : undefined

  if (capabilities.childModel === "unsupported" && capabilities.childReasoning === "unsupported") {
    return {
      status: "inert",
      label: "not applied to children",
      tone: "outline",
      sentence: `${entry.label} exposes no way to set a delegated child's model, so Observer never steers one here. This target is recorded against the day it can be.`,
      requiresReload: capabilities.requiresReload,
      reloadSentence: reload,
      warnings: entry.warnings,
    }
  }

  if (capabilities.childModel === "experimental" || capabilities.childReasoning === "experimental") {
    return {
      status: "experimental",
      label: "experimental",
      tone: "warning",
      sentence: seatControl
        ? `${entry.label} child control is prototyped, not hardened. Observer fails open: if the rewrite does not land, your delegation still runs — on ${entry.label}'s own choice of model, not this one.`
        : `${entry.label} child control is prototyped, not hardened, and seat control is off, so nothing is attempted at all. This target is recorded and inert.`,
      requiresReload: capabilities.requiresReload,
      reloadSentence: reload,
      warnings: entry.warnings,
    }
  }

  if (!seatControl) {
    return {
      status: "configured",
      label: "configured, not applied",
      tone: "secondary",
      sentence: `${entry.label} can honour this, but seat control is off, so the host keeps choosing the model. Turn seat control on to apply it. Skills apply either way.`,
      requiresReload: capabilities.requiresReload,
      reloadSentence: reload,
      warnings: entry.warnings,
    }
  }

  return {
    status: "applied",
    label: "applied",
    tone: "success",
    sentence: `Observer writes a hidden per-employee ${entry.label} agent definition and points the delegation at it, so a child seated here runs this model.`,
    requiresReload: capabilities.requiresReload,
    reloadSentence: reload,
    warnings: entry.warnings,
  }
}

/**
 * The three ways a host can be absent from the directory.
 *
 * Kept apart because a user can act on each differently: wait, retry, or fix
 * the config. The third case covers both a typo (`cursur`) and a host Observer
 * knows by name but ships no adapter for (`cursor`, `grok`) — the sentence is
 * written to be true of both, since the browser cannot tell them apart and
 * guessing would put a spelling correction under a legitimate config.
 */
function missingEntry(directory: HostDirectory, host: string): ControlVerdict {
  if (!directory.settled) {
    return {
      status: "unknown",
      label: "checking…",
      tone: "outline",
      sentence: "Observer is still reading which hosts it can configure, so it has nothing to say about this target yet.",
      requiresReload: false,
      reloadSentence: undefined,
      warnings: [],
    }
  }
  if (directory.error !== undefined) {
    return {
      status: "unknown",
      label: "control unknown",
      tone: "outline",
      sentence: `Observer could not read its host list, so it cannot say what "${host}" would do with this target: ${directory.error}`,
      requiresReload: false,
      reloadSentence: undefined,
      warnings: [],
    }
  }
  return {
    status: "inert",
    label: "no adapter",
    tone: "outline",
    sentence: `No adapter in this build of Observer claims "${host}", so nothing here is applied and no delegated child on it is ever steered. Correct the host if it is a typo, or keep the target for when an adapter lands.`,
    requiresReload: false,
    reloadSentence: undefined,
    warnings: [],
  }
}

/**
 * Why a saved change has not happened yet.
 *
 * OpenCode reads agent definitions once, at startup. A file written now does
 * nothing until it restarts, and a surface that does not say so leaves the user
 * watching a setting apparently fail and toggling it again.
 */
function reloadNote(label: string): string {
  return `${label} reads its agent definitions once, at startup, so this takes effect the next time you start ${label} — not in a session that is already open.`
}

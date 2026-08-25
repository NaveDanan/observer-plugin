/**
 * What `observer install` and `observer uninstall` print.
 *
 * The installer touches one host at a time and used to say so one line at a
 * time: a padded three-column row, then every note flattened underneath at the
 * same indent, in the same ink, whatever it was about. Installing four hosts
 * produced a wall in which the sentence "this would record every event twice"
 * looked exactly like the sentence "restart OpenCode", and the run's most
 * important line was the one nobody read.
 *
 * So the report is built here instead, as a pure function of what the
 * installer returned:
 *
 *  - **One block per host**, headed by the host's name and what happened to
 *    it, so the reader scans host names rather than paths.
 *  - **Notes wrap to the terminal**, with a hanging indent, so a note that
 *    names two paths does not run off the right edge.
 *  - **Colour is a theme the caller passes in.** Nothing here reads the
 *    environment, so `NO_COLOR`, a pipe and a test all get the same plain
 *    text the command has always printed, and the shape survives without it:
 *    every distinction is also a word, a bullet or an indent.
 */

import type { InstallResult } from "./install.js"
import { wordmark } from "./logo.js"
import { PLAIN_THEME, type Theme, padEnd, visibleLength } from "./theme.js"
import { versionLabel } from "./version.js"

/** A conflict the run found, and the command that resolves it. */
export interface HostWarning {
  message: string
  /** What the command below does, e.g. `Remove one with:`. */
  remedyLabel: string
  /** The command to run, printed under the message. */
  remedy: string
}

/** One host's outcome, as the report draws it. */
export interface HostSection {
  /** How the host calls itself, e.g. `Copilot CLI` or `Codex (plugin)`. */
  label: string
  action: InstallResult["action"]
  path: string
  notes: string[]
  warnings: HostWarning[]
}

export interface InstallReport {
  command: "install" | "uninstall"
  sections: HostSection[]
  /** Remarks about the run as a whole rather than about any one host. */
  footnotes: string[]
}

export interface InstallReportOptions {
  /** The version the banner reports. Omitted means a dev build. */
  version?: string
  /** Omitted means plain text: no ANSI at all. */
  theme?: Theme
  /** Terminal width, for wrapping. Omitted means a conservative 80. */
  columns?: number
}

/** The narrowest terminal the report is laid out for. */
const DEFAULT_COLUMNS = 80

/** Width of the host column, wide enough for `Copilot CLI (plugin)`. */
const LABEL_WIDTH = 22

const BLOCK_INDENT = "  "
const DETAIL_INDENT = "    "
const NOTE_HANGING_INDENT = "      "

/**
 * The action verbs, in the ink that says how the run went.
 *
 * `unchanged` is deliberately not `good`: it is the answer to a question the
 * user did not ask, and painting it green next to a real install invites the
 * reading that something was written when nothing was.
 */
function actionStyle(action: HostSection["action"], theme: Theme): (text: string) => string {
  switch (action) {
    case "installed":
    case "updated":
    case "removed":
      return theme.good
    case "unchanged":
      return theme.dim
    case "missing":
      return theme.alert
  }
}

/**
 * The report, as lines ready to write.
 *
 * Returned rather than printed so the shape can be asserted on without a
 * terminal, which is the same split `config-ui-render` uses.
 */
export function renderInstallReport(report: InstallReport, options: InstallReportOptions = {}): string[] {
  const theme = options.theme ?? PLAIN_THEME
  const columns = Math.max(40, options.columns ?? DEFAULT_COLUMNS)
  const lines = [...banner(report, theme, options.version)]

  for (const section of report.sections) {
    lines.push("")
    lines.push(...hostBlock(section, theme, columns))
  }

  const closing = report.footnotes
  if (closing.length > 0) {
    lines.push("")
    for (const line of closing) lines.push(...wrap(line, columns, BLOCK_INDENT, BLOCK_INDENT, theme.dim))
  }
  if (report.command === "install") {
    lines.push("")
    lines.push(
      ...wrap(
        "Hooks bring the daemon up on their own the first time an agent runs.",
        columns,
        BLOCK_INDENT,
        BLOCK_INDENT,
        theme.dim,
      ),
    )
    lines.push(`${BLOCK_INDENT}${theme.dim("To look at the canvas now:")} ${theme.accent("observer start && observer open")}`)
  }
  return lines
}

/**
 * The wordmark, with what this run did beside it.
 *
 * The same three lines `observer config` opens with — what this is, who makes
 * it, which build — so a user who has seen one screen recognises the other,
 * and a bug report names a version without anyone having to ask for it.
 */
function banner(report: InstallReport, theme: Theme, version: string | undefined): string[] {
  return wordmark(theme.depth, [
    theme.title(`Observer ${versionLabel(version ?? "dev")}`),
    theme.dim("By NJ-Labs"),
    theme.dim(summary(report)),
  ])
}

function summary(report: InstallReport): string {
  const count = report.sections.length
  const hosts = `${count} host${count === 1 ? "" : "s"}`
  return report.command === "install" ? `installing into ${hosts}` : `removing from ${hosts}`
}

/**
 * One host: a heading carrying the outcome, the file that carries it, then
 * whatever the installer had to say about it.
 *
 * The path sits on its own line under the heading rather than beside it. It is
 * the longest thing on screen and the least often read, and putting it in a
 * third column is what forced every heading to compete with it for width.
 */
function hostBlock(section: HostSection, theme: Theme, columns: number): string[] {
  const lines = [
    `${BLOCK_INDENT}${theme.heading(padEnd(section.label, LABEL_WIDTH))}${actionStyle(section.action, theme)(section.action)}`,
    ...wrap(section.path, columns, DETAIL_INDENT, DETAIL_INDENT, theme.dim),
  ]
  for (const note of section.notes) {
    lines.push(...wrap(note, columns, `${DETAIL_INDENT}${theme.accent("-")} `, NOTE_HANGING_INDENT, theme.dim))
  }
  for (const warning of section.warnings) {
    lines.push(...wrap(warning.message, columns, `${DETAIL_INDENT}${theme.warn("!")} `, NOTE_HANGING_INDENT, theme.warn))
    lines.push(`${NOTE_HANGING_INDENT}${theme.dim(warning.remedyLabel)} ${theme.accent(warning.remedy)}`)
  }
  return lines
}

/**
 * Wraps `text` to the terminal, styling each line and indenting continuations.
 *
 * Words are never broken, which means a path longer than the terminal is wide
 * overflows rather than being split: a path the user cannot copy in one piece
 * is worse than a line that wraps in the terminal's own way. `prefix` may
 * carry colour of its own — the bullet is accent while the sentence is dim —
 * so it is measured visibly rather than by length.
 */
function wrap(text: string, columns: number, prefix: string, hanging: string, style: (text: string) => string): string[] {
  const first = Math.max(8, columns - visibleLength(prefix))
  const rest = Math.max(8, columns - visibleLength(hanging))
  const lines: string[] = []
  let width = first
  let current = ""
  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    if (current.length === 0) {
      current = word
      continue
    }
    if (current.length + 1 + word.length > width) {
      lines.push(current)
      current = word
      width = rest
      continue
    }
    current = `${current} ${word}`
  }
  if (current.length > 0) lines.push(current)
  return lines.map((line, at) => `${at === 0 ? prefix : hanging}${style(line)}`)
}

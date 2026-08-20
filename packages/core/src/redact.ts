/**
 * Secret redaction applied before anything is written to disk.
 *
 * Observer stores prompts, chat history and tool output, so redaction runs at
 * ingest time rather than at display time: data that is never written cannot
 * leak from the database later.
 */

export interface RedactionOptions {
  enabled: boolean
  /** Maximum characters kept per captured string. */
  maxTextLength: number
  /** Extra user-supplied regular expressions. */
  extraPatterns?: RegExp[]
}

export const DEFAULT_REDACTION: RedactionOptions = {
  enabled: true,
  maxTextLength: 64_000,
}

const PLACEHOLDER = "[redacted]"

const PATTERNS: RegExp[] = [
  // Provider and platform tokens with recognisable prefixes.
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // PEM private keys.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Authorization headers.
  /\b(?:Authorization|Proxy-Authorization)\s*[:=]\s*(?:Bearer|Basic|Token)?\s*[A-Za-z0-9._~+/=-]{12,}/gi,
]

// `KEY=value` style assignments where the key name looks sensitive.
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([^\s"',;]{6,})\3/gi

/** Redacts secrets and enforces the size cap. Returns the safe string. */
export function redactText(value: string, options: RedactionOptions = DEFAULT_REDACTION): string {
  let result = value
  if (options.enabled) {
    for (const pattern of PATTERNS) result = result.replace(pattern, PLACEHOLDER)
    result = result.replace(ASSIGNMENT, (_match, key: string, sep: string, quote: string) => {
      return `${key}${sep}${quote}${PLACEHOLDER}${quote}`
    })
    for (const pattern of options.extraPatterns ?? []) {
      result = result.replace(pattern, PLACEHOLDER)
    }
  }
  if (result.length > options.maxTextLength) {
    const kept = result.slice(0, options.maxTextLength)
    return `${kept}\n\u2026 [truncated ${result.length - options.maxTextLength} characters]`
  }
  return result
}

/** Recursively redacts strings inside an arbitrary JSON-ish value. */
export function redactValue(value: unknown, options: RedactionOptions = DEFAULT_REDACTION, depth = 0): unknown {
  if (depth > 8) return "[depth limit]"
  if (typeof value === "string") return redactText(value, options)
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactValue(item, options, depth + 1))
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactValue(item, options, depth + 1)
    }
    return result
  }
  return value
}

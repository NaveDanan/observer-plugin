import { ROSTER } from "./roster.js"
import type { EmployeeMatch, MatchReason, RosterProfile } from "./types.js"

/**
 * Task-to-employee matcher.
 *
 * Scores free text (a delegation prompt, agent description or session goal)
 * against every roster profile and ranks the results. Purely lexical and
 * deterministic: the same task always seats the same employee, so the canvas
 * never flickers between personas while an agent runs.
 */

/** Below this score no assignment is made; the node renders as unassigned. */
const MIN_SCORE = 2

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have",
  "in", "into", "is", "it", "its", "of", "on", "or", "that", "the", "their", "them",
  "then", "there", "this", "to", "was", "were", "will", "with", "without", "you", "your",
  "our", "we", "us", "i", "me", "my", "he", "she", "they", "who", "whom", "which", "what",
  "when", "where", "why", "how", "not", "no", "yes", "do", "does", "did", "done", "can",
  "could", "should", "would", "may", "might", "must", "shall", "need", "needs", "new",
  "use", "used", "using", "make", "made", "get", "got", "give", "given", "also", "more",
  "most", "some", "any", "all", "each", "every", "other", "than", "too", "very", "just",
])

/** Colloquialisms expanded before matching so aliases hit the same terms. */
const SYNONYMS: Record<string, string> = {
  auth: "authentication",
  authorize: "authorization",
  k8s: "kubernetes",
  db: "database",
  databases: "database",
  js: "javascript",
  ts: "typescript",
  ml: "machine learning",
  ui: "interface",
  ux: "usability",
  a11y: "accessibility",
  ci: "cicd",
  cd: "cicd",
  pipeline: "cicd",
  pipelines: "cicd",
  deploy: "deployment",
  deploying: "deployment",
  deploys: "deployment",
  infra: "infrastructure",
  perf: "performance",
  refactor: "maintainability",
  flaky: "flaky",
  bug: "defect",
  bugs: "defect",
  frontend: "frontend",
  frontends: "frontend",
  backend: "backend",
  backends: "backend",
  devops: "devops",
  sre: "reliability",
  qa: "testing",
  tests: "testing",
  testing: "testing",
  pcb: "pcb",
  firmware: "firmware",
  roadmap: "roadmap",
  metrics: "metrics",
  kpis: "kpi",
  dashboard: "dashboard",
  dashboards: "dashboard",
  forecast: "forecasting",
  forecasts: "forecasting",
  ab: "ab test",
  experiment: "experiment",
  experiments: "experiment",
}

interface ProfileIndex {
  profile: RosterProfile
  /** Single-term weights, document-frequency discounted. */
  terms: Map<string, number>
  /** Multi-word capability phrases, matched as substrings. */
  phrases: string[]
  /** Trigger situations, matched as substrings. */
  triggers: string[]
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim()
}

function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of normalize(text).split(" ")) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue
    out.push(raw)
    const synonym = SYNONYMS[raw]
    if (synonym) {
      for (const part of normalize(synonym).split(" ")) {
        if (part.length >= 2 && !STOPWORDS.has(part)) out.push(part)
      }
    }
  }
  return out
}

/** Words that carry meaning; used for phrase indexes. */
function contentWords(text: string): string[] {
  return tokenize(text).filter((word) => !SYNONYMS[word] || word === SYNONYMS[word])
}

function buildIndex(profile: RosterProfile): ProfileIndex {
  // Document frequency: how many colleagues share each term. Shared terms
  // ("design", "engineering") are discounted so distinctive ones dominate.
  const df = new Map<string, number>()
  const sources = [
    ...profile.fields,
    profile.title,
    profile.shortDescription,
  ]
  const bags = sources.map((source) => new Set(contentWords(source)))
  for (const bag of bags) {
    for (const word of bag) df.set(word, (df.get(word) ?? 0) + 1)
  }

  const terms = new Map<string, number>()
  const addTerm = (word: string, base: number): void => {
    const frequency = df.get(word) ?? 1
    const weight = base / (1 + 0.5 * (frequency - 1))
    const existing = terms.get(word) ?? 0
    if (weight > existing) terms.set(word, weight)
  }

  for (const field of profile.fields) {
    const words = contentWords(field)
    if (words.length === 0) continue
    if (words.length === 1) {
      addTerm(words[0]!, 3)
    } else {
      // Multi-word capabilities mostly earn their keep as phrases; their
      // individual words still count, lightly.
      for (const word of words) addTerm(word, 1)
    }
  }
  for (const word of contentWords(profile.title)) addTerm(word, 1.5)
  for (const word of contentWords(profile.shortDescription)) addTerm(word, 0.5)

  return {
    profile,
    terms,
    phrases: profile.fields.filter((field) => contentWords(field).length > 1).map(normalize),
    triggers: profile.youCallThemWhen.map(normalize),
  }
}

let cachedIndexes: ProfileIndex[] | undefined

function indexes(): ProfileIndex[] {
  if (!cachedIndexes) cachedIndexes = ROSTER.map(buildIndex)
  return cachedIndexes
}

function containsPhrase(haystack: string, phrase: string): boolean {
  return haystack.includes(phrase)
}

/**
 * Ranks every employee against the task text, best first. Always returns up
 * to `limit` entries; callers decide what score is good enough.
 */
export function rankEmployees(task: string, limit = 3): EmployeeMatch[] {
  const normalizedTask = normalize(task)
  if (normalizedTask.length === 0) return []
  const taskTokens = new Set(tokenize(task))

  const matches: EmployeeMatch[] = []
  for (const index of indexes()) {
    let score = 0
    const reasons: MatchReason[] = []
    /** Term hits worth naming, strongest first. */
    const termHits: Array<{ term: string; weight: number }> = []

    for (const token of taskTokens) {
      const weight = index.terms.get(token)
      if (weight && weight > 0) {
        score += weight
        if (weight >= 2) termHits.push({ term: token, weight })
      }
    }

    for (const phrase of index.phrases) {
      if (containsPhrase(normalizedTask, phrase)) {
        score += 4
        reasons.push({ kind: "skill", detail: phrase })
      }
    }

    for (const trigger of index.triggers) {
      if (containsPhrase(normalizedTask, trigger)) {
        score += 3
        reasons.push({ kind: "trigger", detail: trigger })
      }
    }

    // Name the strongest single-term hits after phrase/trigger evidence.
    termHits.sort((a, b) => b.weight - a.weight)
    for (const hit of termHits.slice(0, 3)) {
      reasons.push({ kind: "skill", detail: hit.term })
    }

    matches.push({ profile: index.profile, score, reasons: reasons.slice(0, 4) })
  }

  matches.sort(
    (a, b) =>
      b.score - a.score ||
      b.profile.yearsOfExperience - a.profile.yearsOfExperience ||
      a.profile.id.localeCompare(b.profile.id),
  )
  return matches.slice(0, Math.max(1, limit))
}

/**
 * The single best employee for a task, or undefined when nothing scores above
 * the confidence floor. The undefined case matters: Observer never invents an
 * assignment it cannot support.
 */
export function matchEmployee(task: string): EmployeeMatch | undefined {
  const [best] = rankEmployees(task, 1)
  if (!best || best.score < MIN_SCORE) return undefined
  return best
}

/** Human-readable label for a match reason, used by the worker card. */
export function describeReason(reason: MatchReason): string {
  if (reason.kind === "trigger") return `Called when: ${reason.detail}`
  return `Skill match: ${reason.detail}`
}

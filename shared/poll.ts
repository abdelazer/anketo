/**
 * The poll model, shared verbatim between the browser and the Netlify Functions.
 *
 * Two rules live here rather than in either half, because both halves depend on
 * agreeing about them exactly:
 *   1. When a question's answers become visible (`revealAt`), which is derived
 *      from server time so every device reaches it simultaneously.
 *   2. How raw answers become a tally, so Lead and the API can't disagree.
 */

export const MIN_DURATION = 1
export const MAX_DURATION = 300
export const DEFAULT_DURATION = 20

export const MAX_QUESTIONS = 50
export const MAX_OPTIONS = 10
export const MAX_PROMPT_LEN = 200
export const MAX_OPTION_LEN = 80
export const MAX_TEXT_ANSWER_LEN = 140
export const MAX_DEVICES = 400

export type QuestionType = 'choice' | 'text'

export interface Option {
  id: string
  text: string
}

export interface Question {
  id: string
  type: QuestionType
  prompt: string
  /** Present for `choice`; author order is canonical (respondents see a shuffle). */
  options: Option[]
}

export type Phase = 'draft' | 'active' | 'complete'

export interface Poll {
  id: string
  createdAt: number
  updatedAt: number
  /** Bumped on every write; lets a stale editor detect it has been overtaken. */
  rev: number
  /**
   * Which run of this poll we are on. It prefixes every answer key, so
   * "Reset all answers" is a single increment rather than a mass delete, and
   * a late submission from the previous run can never leak into this one.
   */
  run: number
  title: string
  durationSec: number
  questions: Question[]
  phase: Phase
  /** Index of the question the Leader has made Ready. -1 while draft. */
  currentIndex: number
  /** Server ms at which each question was made Ready, keyed by question id. */
  readyAtByQ: Record<string, number>
}

/** `{ [questionId]: { [deviceId]: answer } }` - answer is an option id or text. */
export type Answers = Record<string, Record<string, string>>

export interface ChoiceTally {
  type: 'choice'
  total: number
  /** Canonical author order, so the chart and the question agree. */
  counts: { optionId: string; text: string; count: number }[]
}

export interface TextTally {
  type: 'text'
  total: number
  /** Deduplicated by normalized form, most-repeated first. */
  entries: { text: string; count: number }[]
}

export type Tally = ChoiceTally | TextTally

/** A poll snapshot as the API hands it to a client. */
export interface Snapshot {
  serverTime: number
  poll: Poll
  /** Live count per question - safe during a countdown; a distribution is not. */
  responseCounts: Record<string, number>
  /** Only ever populated for questions past their reveal time. */
  tallies: Record<string, Tally>
  /** Respond view only: this device's own answers. */
  mine?: Record<string, string>
}

/**
 * Server ms at which a question's answers become visible, or null if it was
 * never made Ready. Both Lead devices derive "question vs. results" from this,
 * which is why the transition needs no write and cannot drift between them.
 */
export function revealAt(poll: Poll, questionId: string): number | null {
  const readyAt = poll.readyAtByQ[questionId]
  if (typeof readyAt !== 'number') return null
  return readyAt + poll.durationSec * 1000
}

export function isRevealed(poll: Poll, questionId: string, now: number): boolean {
  const at = revealAt(poll, questionId)
  return at !== null && now >= at
}

/** Whole seconds left on a question's countdown; 0 once it has expired. */
export function secondsLeft(poll: Poll, questionId: string, now: number): number {
  const at = revealAt(poll, questionId)
  if (at === null) return 0
  return Math.max(0, Math.ceil((at - now) / 1000))
}

/** A question accepts answers once it is Ready and while the poll is Active. */
export function acceptsAnswers(poll: Poll, questionId: string): boolean {
  if (poll.phase !== 'active') return false
  const index = poll.questions.findIndex((q) => q.id === questionId)
  return index >= 0 && index <= poll.currentIndex
}

/** Text answers collapse on case, accents, punctuation and whitespace. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tallyQuestion(question: Question, byDevice: Record<string, string> = {}): Tally {
  const values = Object.values(byDevice)

  if (question.type === 'choice') {
    const counts = new Map<string, number>()
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
    return {
      type: 'choice',
      total: values.length,
      counts: question.options.map((o) => ({
        optionId: o.id,
        text: o.text,
        count: counts.get(o.id) ?? 0,
      })),
    }
  }

  // Group by normalized form but display the most common original spelling, so
  // "New York" wins over "new york" rather than showing a flattened key.
  const groups = new Map<string, Map<string, number>>()
  for (const raw of values) {
    const text = raw.trim()
    if (!text) continue
    const key = normalizeText(text) || text.toLowerCase()
    const variants = groups.get(key) ?? new Map<string, number>()
    variants.set(text, (variants.get(text) ?? 0) + 1)
    groups.set(key, variants)
  }

  const entries = [...groups.values()].map((variants) => {
    let best = ''
    let bestCount = 0
    let count = 0
    for (const [text, n] of variants) {
      count += n
      if (n > bestCount) {
        best = text
        bestCount = n
      }
    }
    return { text: best, count }
  })

  entries.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
  return { type: 'text', total: values.length, entries }
}

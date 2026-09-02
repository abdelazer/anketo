/**
 * Server-side storage.
 *
 * Netlify Blobs has no transactions, and its conditional-write ETag is not
 * available in every runtime (the local dev emulator returns none). Rather than
 * hang correctness on a token we cannot verify, answers are stored so that
 * concurrent writes are impossible in the first place:
 *
 *     a/{pollId}/{run}/{questionId}/{deviceId}  ->  the answer, as text
 *
 * Exactly one device ever writes any given key, so a room answering at once
 * never contends. Two more properties fall out of it:
 *
 *   - Response counts come from the key listing alone, with no reads. During a
 *     countdown — the busiest moment — a Lead refresh is a single list call.
 *   - "Reset all answers" is `run + 1`, an O(1) write, instead of deleting
 *     thousands of keys.
 */
import { getDeployStore, getStore, type Store } from '@netlify/blobs'
import {
  DEFAULT_DURATION,
  MAX_DEVICES,
  MAX_OPTION_LEN,
  MAX_OPTIONS,
  MAX_PROMPT_LEN,
  MAX_QUESTIONS,
  MAX_TEXT_ANSWER_LEN,
  MAX_DURATION,
  MIN_DURATION,
  isRevealed,
  tallyQuestion,
  type Answers,
  type Poll,
  type Question,
  type Snapshot,
  type Tally,
} from './poll'

/**
 * Strong consistency is not optional: a Leader pressing "Next question" and a
 * respondent's very next fetch are causally linked, and eventual consistency
 * would show them the previous question.
 *
 * Preview deploys get a store scoped to their own deploy, because a global
 * store is shared with production: without this, opening a pull request's
 * preview and pressing Start would be pressing Start on a live poll. Local dev
 * and production both stay on the global store, which is where every poll code
 * anyone has been given actually lives.
 */
const PREVIEW_CONTEXTS = new Set(['deploy-preview', 'branch-deploy'])

const store = (): Store => {
  const options = { name: 'anketo', consistency: 'strong' } as const
  return PREVIEW_CONTEXTS.has(process.env.CONTEXT ?? '')
    ? getDeployStore(options)
    : getStore(options)
}

const POLL_KEY = (id: string) => `polls/${id}`
const RUN_PREFIX = (id: string, run: number) => `a/${id}/${run}/`
const Q_PREFIX = (id: string, run: number, questionId: string) =>
  `${RUN_PREFIX(id, run)}${questionId}/`

/** No 0/O/1/I/l — these ids get read aloud and typed off a projected screen. */
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

export function newId(length = 7): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Every response carries live state; a cached copy would be worse than useless.
      'cache-control': 'no-store',
    },
  })
}

// ---------------------------------------------------------------------------
// The poll document
// ---------------------------------------------------------------------------

export async function loadPoll(id: string): Promise<Poll> {
  const poll = (await store().get(POLL_KEY(id), { type: 'json' })) as Poll | null
  if (!poll) throw new HttpError(404, 'No poll with that code.')
  // `run` was added after the first polls were written; default it in.
  return { ...poll, run: typeof poll.run === 'number' ? poll.run : 1 }
}

/**
 * Read–modify–write on the poll document.
 *
 * Unlike answers this one document does have multiple writers — an editor and
 * up to two Lead devices — but they are never active at the same time: the
 * editor is locked from Start Poll onward, and simultaneous Leader taps are
 * idempotent by construction (both are trying to reach the same state, and
 * `next` carries the index it is advancing *from*). Last write wins is
 * therefore the correct resolution here, not a race to paper over.
 */
export async function updatePoll(id: string, apply: (poll: Poll) => Poll): Promise<Poll> {
  const current = await loadPoll(id)
  const next = { ...apply(current), rev: current.rev + 1, updatedAt: Date.now() }
  await store().setJSON(POLL_KEY(id), next)
  return next
}

export async function createPoll(): Promise<Poll> {
  const now = Date.now()
  const poll: Poll = {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    rev: 1,
    run: 1,
    title: '',
    durationSec: DEFAULT_DURATION,
    questions: [blankQuestion('choice')],
    phase: 'draft',
    currentIndex: -1,
    readyAtByQ: {},
  }
  const result = await store().setJSON(POLL_KEY(poll.id), poll, { onlyIfNew: true })
  if (!result.modified) throw new HttpError(409, 'Could not create poll — please retry.')
  return poll
}

export function blankQuestion(type: Question['type']): Question {
  return {
    id: newId(6),
    type,
    prompt: '',
    options: type === 'choice' ? [emptyOption(), emptyOption()] : [],
  }
}

function emptyOption() {
  return { id: newId(6), text: '' }
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** Device ids land in blob keys, so they get a strict shape of their own. */
const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/

export function assertDeviceId(value: unknown): string {
  if (typeof value !== 'string' || !DEVICE_RE.test(value)) {
    throw new HttpError(400, 'Bad device id.')
  }
  return value
}

interface AnswerKey {
  questionId: string
  deviceId: string
  key: string
}

/** Every answer key for the current run — one list call, no reads. */
async function listAnswerKeys(poll: Poll): Promise<AnswerKey[]> {
  const prefix = RUN_PREFIX(poll.id, poll.run)
  const { blobs } = await store().list({ prefix })
  return blobs.flatMap(({ key }) => {
    const [questionId, deviceId] = key.slice(prefix.length).split('/')
    return questionId && deviceId ? [{ questionId, deviceId, key }] : []
  })
}

/** Fetch a set of answer keys, bounded so one huge room cannot stall a request. */
async function readValues(keys: AnswerKey[]): Promise<Map<string, string>> {
  const s = store()
  const out = new Map<string, string>()
  const CONCURRENCY = 32

  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    const batch = keys.slice(i, i + CONCURRENCY)
    const values = await Promise.all(batch.map((k) => s.get(k.key, { type: 'text' })))
    batch.forEach((k, index) => {
      const value = values[index]
      if (typeof value === 'string') out.set(k.key, value)
    })
  }
  return out
}

export async function writeAnswer(
  poll: Poll,
  questionId: string,
  deviceId: string,
  value: string,
): Promise<void> {
  await store().set(`${Q_PREFIX(poll.id, poll.run, questionId)}${deviceId}`, value)
}

export async function readAnswer(
  poll: Poll,
  questionId: string,
  deviceId: string,
): Promise<string | null> {
  return store().get(`${Q_PREFIX(poll.id, poll.run, questionId)}${deviceId}`, { type: 'text' })
}

/** Reject a brand-new device once a poll is at capacity; existing ones may edit. */
export async function assertRoom(
  poll: Poll,
  questionId: string,
  deviceId: string,
): Promise<void> {
  const prefix = Q_PREFIX(poll.id, poll.run, questionId)
  const { blobs } = await store().list({ prefix })
  if (blobs.length < MAX_DEVICES) return
  if (!blobs.some((b) => b.key === `${prefix}${deviceId}`)) {
    throw new HttpError(429, 'This poll has reached its response limit.')
  }
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

/**
 * Which questions this request is allowed to see full answers for.
 *
 * The reveal gate is enforced here, on the server, rather than by hiding the
 * chart in Lead mode: a question that has not finished its countdown never has
 * its distribution put on the wire at all, so nothing a client does can surface
 * early results. Only a bare count goes out, which is useful to a presenter and
 * cannot influence a respondent.
 */
function revealedForView(poll: Poll, view: View, now: number): string[] {
  if (view === 'create' || view === 'respond') return []

  const revealed = poll.questions.filter((q) => isRevealed(poll, q.id, now)).map((q) => q.id)
  if (poll.phase === 'complete') return revealed

  // While running, Lead only ever draws the current question — fetching the
  // rest would be reads nobody looks at.
  const current = poll.questions[poll.currentIndex]
  return current && revealed.includes(current.id) ? [current.id] : []
}

export type View = 'lead' | 'respond' | 'create'

export async function loadSnapshot(
  poll: Poll,
  options: { view: View; deviceId?: string },
): Promise<Snapshot> {
  const now = Date.now()
  const keys = await listAnswerKeys(poll)

  // Counts need no reads at all — the keys alone carry them.
  const responseCounts: Record<string, number> = {}
  for (const question of poll.questions) responseCounts[question.id] = 0
  for (const { questionId } of keys) {
    if (questionId in responseCounts) responseCounts[questionId] += 1
  }

  const wanted = new Set(revealedForView(poll, options.view, now))
  const mineKeys =
    options.view === 'respond' && options.deviceId
      ? keys.filter((k) => k.deviceId === options.deviceId)
      : []

  const needed = [...keys.filter((k) => wanted.has(k.questionId)), ...mineKeys]
  const values = await readValues(dedupe(needed))

  const answers: Answers = {}
  for (const { questionId, deviceId, key } of keys) {
    if (!wanted.has(questionId)) continue
    const value = values.get(key)
    if (value === undefined) continue
    ;(answers[questionId] ??= {})[deviceId] = value
  }

  const tallies: Record<string, Tally> = {}
  for (const question of poll.questions) {
    if (wanted.has(question.id)) {
      tallies[question.id] = tallyQuestion(question, answers[question.id] ?? {})
    }
  }

  const snapshot: Snapshot = { serverTime: now, poll, responseCounts, tallies }

  if (options.view === 'respond' && options.deviceId) {
    const mine: Record<string, string> = {}
    for (const k of mineKeys) {
      const value = values.get(k.key)
      if (value !== undefined) mine[k.questionId] = value
    }
    snapshot.mine = mine
  }

  return snapshot
}

function dedupe(keys: AnswerKey[]): AnswerKey[] {
  const seen = new Set<string>()
  return keys.filter((k) => (seen.has(k.key) ? false : (seen.add(k.key), true)))
}

// ---------------------------------------------------------------------------
// Validation — never trust a poll document that arrived over the wire
// ---------------------------------------------------------------------------

const clampText = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max).trimStart() : ''

/**
 * Coerce a client-supplied draft into a well-formed poll, keeping the server's
 * own run-state fields (phase, currentIndex, readyAtByQ, run) so an edit can
 * never move the poll's position or resurrect a previous run's answers.
 */
export function sanitizeDraft(incoming: unknown, base: Poll): Poll {
  const raw = (incoming ?? {}) as Partial<Poll>

  const duration = Math.round(Number(raw.durationSec))
  const durationSec = Number.isFinite(duration)
    ? Math.min(MAX_DURATION, Math.max(MIN_DURATION, duration))
    : base.durationSec

  const seen = new Set<string>()
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .slice(0, MAX_QUESTIONS)
    .map((q: Partial<Question>): Question => {
      const type: Question['type'] = q?.type === 'text' ? 'text' : 'choice'
      // A duplicate id would silently merge two questions' answers.
      let id = typeof q?.id === 'string' && /^[a-z0-9]{4,12}$/.test(q.id) ? q.id : newId(6)
      while (seen.has(id)) id = newId(6)
      seen.add(id)

      const optionIds = new Set<string>()
      const options =
        type === 'choice'
          ? (Array.isArray(q?.options) ? q.options : []).slice(0, MAX_OPTIONS).map((o) => {
              let oid = typeof o?.id === 'string' && /^[a-z0-9]{4,12}$/.test(o.id) ? o.id : newId(6)
              while (optionIds.has(oid)) oid = newId(6)
              optionIds.add(oid)
              return { id: oid, text: clampText(o?.text, MAX_OPTION_LEN) }
            })
          : []

      return { id, type, prompt: clampText(q?.prompt, MAX_PROMPT_LEN), options }
    })

  return { ...base, title: clampText(raw.title, MAX_PROMPT_LEN), durationSec, questions }
}

export function sanitizeAnswer(question: Question, value: unknown): string {
  if (question.type === 'choice') {
    const id = typeof value === 'string' ? value : ''
    if (!question.options.some((o) => o.id === id)) {
      throw new HttpError(400, 'That option is not on this question.')
    }
    return id
  }
  const text = typeof value === 'string' ? value.trim().slice(0, MAX_TEXT_ANSWER_LEN) : ''
  if (!text) throw new HttpError(400, 'Answer cannot be empty.')
  return text
}

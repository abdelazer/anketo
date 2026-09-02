import { BASE_URL } from './setup/netlify-dev'
import type { Poll, Question, Snapshot } from '../shared/poll'

export interface ApiResult<T> {
  status: number
  body: T
}

async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as T }
}

type ErrorBody = { error: string }

export const api = {
  create: (copyFrom?: string) =>
    call<{ id: string } & Partial<ErrorBody>>(
      'POST',
      '/api/poll',
      copyFrom === undefined ? undefined : { copyFrom },
    ),

  snapshot: (id: string, view: 'lead' | 'respond' | 'create', device?: string) => {
    const params = new URLSearchParams({ id, view })
    if (device) params.set('device', device)
    return call<Snapshot & Partial<ErrorBody>>('GET', `/api/poll?${params}`)
  },

  save: (id: string, rev: number | undefined, poll: unknown) =>
    call<Snapshot & Partial<ErrorBody>>('PUT', '/api/poll', { id, rev, poll }),

  act: (id: string, action: 'start' | 'next' | 'complete' | 'reset', index?: number) =>
    call<Snapshot & Partial<ErrorBody>>('POST', '/api/action', { id, action, index }),

  answer: (id: string, questionId: string, deviceId: string, value: unknown) =>
    call<Snapshot & Partial<ErrorBody>>('POST', '/api/answer', {
      id,
      questionId,
      deviceId,
      value,
    }),
}

/** Assert a call succeeded and hand back the body, so tests read as prose. */
export function ok<T>(result: ApiResult<T>): T {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`expected success, got ${result.status}: ${JSON.stringify(result.body)}`)
  }
  return result.body
}

export interface DraftQuestion {
  type: Question['type']
  prompt: string
  options?: string[]
}

export interface TestPoll {
  id: string
  poll: Poll
  /** Question ids, in author order. */
  q: string[]
  /** Option ids per question, in author order. */
  o: string[][]
}

/**
 * Create a poll and populate it in one step.
 *
 * Ids are always read back from the response rather than assumed: the server
 * regenerates any id that does not match its own shape, and an early version
 * of this suite silently tested a poll whose questions it had never written.
 */
export async function makePoll(
  questions: DraftQuestion[],
  durationSec = 2,
  title = 'Test poll',
): Promise<TestPoll> {
  const { id } = ok(await api.create())
  const before = ok(await api.snapshot(id, 'create'))

  const saved = ok(
    await api.save(id, before.poll.rev, {
      title,
      durationSec,
      questions: questions.map((q) => ({
        type: q.type,
        prompt: q.prompt,
        options: (q.options ?? []).map((text) => ({ text })),
      })),
    }),
  )

  return {
    id,
    poll: saved.poll,
    q: saved.poll.questions.map((question) => question.id),
    o: saved.poll.questions.map((question) => question.options.map((option) => option.id)),
  }
}

/** Device ids must satisfy the server's key-safe shape (8–64 of [A-Za-z0-9_-]). */
export const device = (n: number | string): string => `device-${String(n).padStart(4, '0')}`

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Wait out a question's countdown using the server's own clock, plus a margin.
 * Sleeping a fixed wall-clock interval would drift against the dev server.
 */
export async function waitForReveal(poll: TestPoll, questionIndex = 0): Promise<void> {
  const snapshot = ok(await api.snapshot(poll.id, 'lead'))
  const questionId = snapshot.poll.questions[questionIndex].id
  const readyAt = snapshot.poll.readyAtByQ[questionId]
  if (readyAt === undefined) throw new Error(`question ${questionIndex} was never made ready`)

  const revealAt = readyAt + snapshot.poll.durationSec * 1000
  const remaining = revealAt - snapshot.serverTime
  await sleep(Math.max(0, remaining) + 400)
}

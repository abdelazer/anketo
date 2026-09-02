/** A respondent submitting or changing their answer to one question. */
import {
  HttpError,
  assertDeviceId,
  assertRoom,
  json,
  loadPoll,
  loadSnapshot,
  readAnswer,
  sanitizeAnswer,
  writeAnswer,
} from '../../shared/server'
import { acceptsAnswers, isRevealed } from '../../shared/poll'

export default async (req: Request): Promise<Response> => {
  try {
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

    const body = (await req.json()) as {
      id?: string
      questionId?: string
      deviceId?: string
      value?: unknown
    }
    if (!body.id || !body.questionId) throw new HttpError(400, 'Missing fields.')
    const deviceId = assertDeviceId(body.deviceId)

    const poll = await loadPoll(body.id)
    const question = poll.questions.find((q) => q.id === body.questionId)
    if (!question) throw new HttpError(404, 'No such question.')
    if (!acceptsAnswers(poll, question.id)) {
      throw new HttpError(409, 'This question is not open for answers.')
    }

    const value = sanitizeAnswer(question, body.value)

    // Latecomers may still answer once, but nobody may change an answer after
    // the countdown — by then the room is already looking at the results.
    if (isRevealed(poll, question.id, Date.now())) {
      if ((await readAnswer(poll, question.id, deviceId)) !== null) {
        throw new HttpError(409, 'Time is up — your answer is locked in.')
      }
    }

    await assertRoom(poll, question.id, deviceId)
    // Only this device ever writes this key, so there is nothing to race with.
    await writeAnswer(poll, question.id, deviceId, value)

    return json(await loadSnapshot(poll, { view: 'respond', deviceId }))
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status)
    console.error('answer function failed', error)
    return json({ error: 'Something went wrong.' }, 500)
  }
}

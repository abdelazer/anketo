/**
 * Leader controls. These are named actions rather than document writes on
 * purpose: with Lead mode open on a laptop and a phone, "advance to the next
 * question" must mean the same thing whichever device sends it, and the
 * timestamp that starts a countdown has to come from the server clock rather
 * than from whichever device happened to tap.
 */
import { HttpError, json, loadSnapshot, updatePoll } from '../../shared/server'
import type { Poll } from '../../shared/poll'

type Action = 'start' | 'next' | 'complete' | 'reset'

/** A question is runnable once it has a prompt and, if choice, two real options. */
function readyToRun(poll: Poll): boolean {
  return (
    poll.questions.length > 0 &&
    poll.questions.every(
      (q) =>
        q.prompt.trim().length > 0 &&
        (q.type === 'text' || q.options.filter((o) => o.text.trim()).length >= 2),
    )
  )
}

function advanceTo(poll: Poll, index: number): Poll {
  const question = poll.questions[index]
  if (!question) return { ...poll, phase: 'complete' }
  return {
    ...poll,
    phase: 'active',
    currentIndex: index,
    readyAtByQ: { ...poll.readyAtByQ, [question.id]: Date.now() },
  }
}

export default async (req: Request): Promise<Response> => {
  try {
    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

    const body = (await req.json()) as { id?: string; action?: Action; index?: number }
    if (!body.id) throw new HttpError(400, 'Missing poll id.')

    const saved = await updatePoll(body.id, (poll): Poll => {
      switch (body.action) {
        case 'start': {
          if (poll.phase === 'active') return poll // Both Lead devices tapped Start.
          if (!readyToRun(poll)) {
            throw new HttpError(400, 'Every question needs a prompt, and choices need two options.')
          }
          return advanceTo({ ...poll, readyAtByQ: {} }, 0)
        }

        case 'next': {
          if (poll.phase !== 'active') throw new HttpError(409, 'The poll is not running.')
          // `index` is the question the tapping device was looking at, so a
          // duplicate tap from the second Lead device is a no-op rather than a
          // double-advance that skips a question nobody ever saw.
          const from = typeof body.index === 'number' ? body.index : poll.currentIndex
          if (from < poll.currentIndex) return poll
          return advanceTo(poll, poll.currentIndex + 1)
        }

        case 'complete':
          return { ...poll, phase: 'complete' }

        case 'reset':
          // Incrementing the run orphans every answer key from the previous
          // session in one write — no mass delete, and no chance of a late
          // submission from the old run bleeding into the new one.
          return {
            ...poll,
            run: poll.run + 1,
            phase: 'draft',
            currentIndex: -1,
            readyAtByQ: {},
          }

        default:
          throw new HttpError(400, 'Unknown action.')
      }
    })

    return json(await loadSnapshot(saved, { view: 'lead' }))
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status)
    console.error('action function failed', error)
    return json({ error: 'Something went wrong.' }, 500)
  }
}

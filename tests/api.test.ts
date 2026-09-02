/**
 * API integration suite, run against a real `netlify dev`.
 *
 * These are the assertions that were verified by hand during the build
 * session, written down so they stop depending on anyone's memory. The
 * groupings follow docs/testing-plan.md.
 */
import { describe, expect, it } from 'vitest'
import { api, device, makePoll, ok, sleep, waitForReveal } from './helpers'

const CHOICE = {
  type: 'choice' as const,
  prompt: 'Best snack?',
  options: ['Crisps', 'Fruit', 'Chocolate'],
}
const TEXT = { type: 'text' as const, prompt: 'One word for this week?' }

describe('lifecycle', () => {
  it('creates a draft poll with one blank choice question', async () => {
    const { id } = ok(await api.create())
    expect(id).toMatch(/^[a-z0-9]{7}$/)

    const { poll } = ok(await api.snapshot(id, 'create'))
    expect(poll.phase).toBe('draft')
    expect(poll.currentIndex).toBe(-1)
    expect(poll.durationSec).toBe(20)
    expect(poll.questions).toHaveLength(1)
    expect(poll.questions[0].type).toBe('choice')
  })

  it('assigns ids to questions and options that arrive without them', async () => {
    const poll = await makePoll([CHOICE, TEXT])
    expect(poll.q).toHaveLength(2)
    for (const id of poll.q) expect(id).toMatch(/^[a-z0-9]{4,12}$/)
    expect(poll.o[0]).toHaveLength(3)
    expect(new Set(poll.o[0]).size).toBe(3)
  })

  it('refuses a save carrying a stale revision', async () => {
    const poll = await makePoll([CHOICE])
    const result = await api.save(poll.id, 1, { questions: [] })
    expect(result.status).toBe(409)
    expect(result.body.error).toMatch(/edited somewhere else/i)
  })

  it('refuses next before the poll has started', async () => {
    const poll = await makePoll([CHOICE])
    const result = await api.act(poll.id, 'next')
    expect(result.status).toBe(409)
    expect(result.body.error).toMatch(/not running/i)
  })

  it('start makes the first question ready', async () => {
    const poll = await makePoll([CHOICE, TEXT])
    const { poll: started } = ok(await api.act(poll.id, 'start'))
    expect(started.phase).toBe('active')
    expect(started.currentIndex).toBe(0)
    expect(started.readyAtByQ[poll.q[0]]).toBeGreaterThan(0)
    expect(started.readyAtByQ[poll.q[1]]).toBeUndefined()
  })

  it('start on an already-running poll does not restart the countdown', async () => {
    // Both Lead devices tapping Start must not hand the room extra time.
    const poll = await makePoll([CHOICE], 10)
    const first = ok(await api.act(poll.id, 'start'))
    await sleep(300)
    const second = ok(await api.act(poll.id, 'start'))
    expect(second.poll.readyAtByQ[poll.q[0]]).toBe(first.poll.readyAtByQ[poll.q[0]])
  })

  it('refuses to start a poll with an empty prompt', async () => {
    const poll = await makePoll([{ type: 'choice', prompt: '', options: ['a', 'b'] }])
    const result = await api.act(poll.id, 'start')
    expect(result.status).toBe(400)
  })

  it('refuses to start a choice question with fewer than two real options', async () => {
    const poll = await makePoll([{ type: 'choice', prompt: 'Pick', options: ['only one', '  '] }])
    const result = await api.act(poll.id, 'start')
    expect(result.status).toBe(400)
  })

  it('complete ends the poll', async () => {
    const poll = await makePoll([CHOICE])
    ok(await api.act(poll.id, 'start'))
    const { poll: done } = ok(await api.act(poll.id, 'complete'))
    expect(done.phase).toBe('complete')
  })
})

describe('the reveal gate', () => {
  it('gives Lead counts but no distribution before the countdown expires', async () => {
    const poll = await makePoll([CHOICE], 10)
    ok(await api.act(poll.id, 'start'))
    ok(await api.answer(poll.id, poll.q[0], device(1), poll.o[0][0]))
    ok(await api.answer(poll.id, poll.q[0], device(2), poll.o[0][1]))

    const lead = ok(await api.snapshot(poll.id, 'lead'))
    expect(lead.responseCounts[poll.q[0]]).toBe(2)
    // The distribution must not exist on the wire at all — this is the
    // anti-anchoring rule, and hiding it in the client would not be enough.
    expect(lead.tallies).toEqual({})
  })

  it('gives Lead the distribution once the countdown expires', async () => {
    const poll = await makePoll([CHOICE])
    ok(await api.act(poll.id, 'start'))
    ok(await api.answer(poll.id, poll.q[0], device(1), poll.o[0][0]))
    await waitForReveal(poll)

    const lead = ok(await api.snapshot(poll.id, 'lead'))
    const tally = lead.tallies[poll.q[0]]
    expect(tally).toBeDefined()
    expect(tally.total).toBe(1)
  })

  it('never gives a respondent tallies, before or after reveal', async () => {
    const poll = await makePoll([CHOICE])
    ok(await api.act(poll.id, 'start'))
    ok(await api.answer(poll.id, poll.q[0], device(1), poll.o[0][0]))

    expect(ok(await api.snapshot(poll.id, 'respond', device(1))).tallies).toEqual({})
    await waitForReveal(poll)
    expect(ok(await api.snapshot(poll.id, 'respond', device(1))).tallies).toEqual({})
  })

  it('gives a respondent only their own answers', async () => {
    const poll = await makePoll([CHOICE], 10)
    ok(await api.act(poll.id, 'start'))
    ok(await api.answer(poll.id, poll.q[0], device(1), poll.o[0][0]))
    ok(await api.answer(poll.id, poll.q[0], device(2), poll.o[0][1]))

    const mine = ok(await api.snapshot(poll.id, 'respond', device(1))).mine
    expect(mine).toEqual({ [poll.q[0]]: poll.o[0][0] })
  })

  it('gives the editor no tallies even after reveal', async () => {
    const poll = await makePoll([CHOICE])
    ok(await api.act(poll.id, 'start'))
    ok(await api.answer(poll.id, poll.q[0], device(1), poll.o[0][0]))
    await waitForReveal(poll)

    expect(ok(await api.snapshot(poll.id, 'create')).tallies).toEqual({})
  })
})

describe('concurrency', () => {
  // Regression test. The original single-blob design with a compare-and-swap
  // lost 7 of 12 simultaneous submissions, because Netlify Blobs returns no
  // ETag in some runtimes and the conditional write degraded to a blind
  // overwrite. Answers now live one key per device, so this cannot recur.
  it('lands every one of 40 simultaneous answers', async () => {
    const poll = await makePoll([CHOICE], 60)
    ok(await api.act(poll.id, 'start'))

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        api.answer(poll.id, poll.q[0], device(i), poll.o[0][i % 3]),
      ),
    )

    expect(results.every((r) => r.status === 200)).toBe(true)
    const lead = ok(await api.snapshot(poll.id, 'lead'))
    expect(lead.responseCounts[poll.q[0]]).toBe(40)
  })

  it('keeps simultaneous answers to different questions separate', async () => {
    const poll = await makePoll([CHOICE, TEXT], 60)
    ok(await api.act(poll.id, 'start'))
    ok(await api.act(poll.id, 'next', 0))

    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) =>
        api.answer(poll.id, poll.q[0], device(i), poll.o[0][0]),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        api.answer(poll.id, poll.q[1], device(100 + i), 'hello'),
      ),
    ])

    const lead = ok(await api.snapshot(poll.id, 'lead'))
    expect(lead.responseCounts[poll.q[0]]).toBe(8)
    expect(lead.responseCounts[poll.q[1]]).toBe(5)
  })
})

describe('answer rules', () => {
  it('lets a respondent change their answer while the countdown runs', async () => {
    const poll = await makePoll([CHOICE], 6)
    ok(await api.act(poll.id, 'start'))

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        api.answer(poll.id, poll.q[0], device(i), poll.o[0][i % 3]),
      ),
    )
    // device(0) moves from option 0 to option 1.
    ok(await api.answer(poll.id, poll.q[0], device(0), poll.o[0][1]))
    await waitForReveal(poll)

    const lead = ok(await api.snapshot(poll.id, 'lead'))
    const tally = lead.tallies[poll.q[0]]
    // Assert the whole distribution, not just the total: a change that added a
    // row instead of moving one would keep the total right and the shape wrong.
    expect(tally.type === 'choice' && tally.counts.map((c) => c.count)).toEqual([3, 5, 4])
    expect(tally.total).toBe(12)
  })

  it('refuses a change once the answers are revealed', async () => {
    const poll = await makePoll([CHOICE])
    ok(await api.act(poll.id, 'start'))
    ok(await api.answer(poll.id, poll.q[0], device(1), poll.o[0][0]))
    await waitForReveal(poll)

    const result = await api.answer(poll.id, poll.q[0], device(1), poll.o[0][1])
    expect(result.status).toBe(409)
    expect(result.body.error).toMatch(/locked in/i)
  })

  it('still accepts a latecomer answering for the first time after reveal', async () => {
    // Easy to break while implementing the rule above; the two rules differ
    // only by whether this device has answered before.
    const poll = await makePoll([CHOICE])
    ok(await api.act(poll.id, 'start'))
    await waitForReveal(poll)

    const late = await api.answer(poll.id, poll.q[0], device('late'), poll.o[0][2])
    expect(late.status).toBe(200)
    expect(late.body.mine).toEqual({ [poll.q[0]]: poll.o[0][2] })
  })

  it('refuses an option id that is not on the question', async () => {
    const poll = await makePoll([CHOICE], 10)
    ok(await api.act(poll.id, 'start'))
    const result = await api.answer(poll.id, poll.q[0], device(1), 'not-an-option')
    expect(result.status).toBe(400)
  })

  it('refuses an empty text answer', async () => {
    const poll = await makePoll([TEXT], 10)
    ok(await api.act(poll.id, 'start'))
    const result = await api.answer(poll.id, poll.q[0], device(1), '   ')
    expect(result.status).toBe(400)
  })

  it('refuses an answer to a question the room has not reached', async () => {
    const poll = await makePoll([CHOICE, TEXT], 10)
    ok(await api.act(poll.id, 'start'))
    const result = await api.answer(poll.id, poll.q[1], device(1), 'too early')
    expect(result.status).toBe(409)
  })

  it('refuses a device id that would escape its own key space', async () => {
    // Device ids are interpolated into blob keys; a slash here would let a
    // client write outside its own namespace.
    const poll = await makePoll([CHOICE], 10)
    ok(await api.act(poll.id, 'start'))

    for (const bad of ['../../polls/hijack', 'a/b/c', '', 'short', 'x'.repeat(200)]) {
      const result = await api.answer(poll.id, poll.q[0], bad, poll.o[0][0])
      expect(result.status, `device id ${JSON.stringify(bad)}`).toBe(400)
    }
  })

  it('merges text answers on case, punctuation and accents', async () => {
    const poll = await makePoll([TEXT])
    ok(await api.act(poll.id, 'start'))

    const answers: [number, string][] = [
      [1, 'Busy'],
      [2, 'busy!'],
      [3, '  BUSY  '],
      [4, 'Café'],
      [5, 'cafe'],
      [6, 'Calm'],
    ]
    for (const [n, value] of answers) ok(await api.answer(poll.id, poll.q[0], device(n), value))
    await waitForReveal(poll)

    const tally = ok(await api.snapshot(poll.id, 'lead')).tallies[poll.q[0]]
    expect(tally.type === 'text' && tally.entries).toEqual([
      // The most common original spelling is what the room sees.
      { text: 'Busy', count: 3 },
      { text: 'Café', count: 2 },
      { text: 'Calm', count: 1 },
    ])
  })
})

describe('reveal is driven by the countdown, not by the poll ending', () => {
  it('does not reveal a question whose countdown never expired, even once complete', async () => {
    // Cutting a poll short must not hand the room answers it never earned:
    // reveal is a function of the countdown, not of the poll being finished.
    const poll = await makePoll([CHOICE], 300)
    ok(await api.act(poll.id, 'start'))
    ok(await api.answer(poll.id, poll.q[0], device(1), poll.o[0][0]))
    ok(await api.act(poll.id, 'complete'))

    const lead = ok(await api.snapshot(poll.id, 'lead'))
    expect(lead.tallies).toEqual({})
    expect(lead.responseCounts[poll.q[0]]).toBe(1)
  })
})

describe('two Lead devices', () => {
  it('does not skip a question when both devices tap Next', async () => {
    const poll = await makePoll([CHOICE, TEXT, { ...CHOICE, prompt: 'Third?' }], 10)
    ok(await api.act(poll.id, 'start'))

    // Both devices were looking at question 0 when they tapped.
    const first = ok(await api.act(poll.id, 'next', 0))
    const second = ok(await api.act(poll.id, 'next', 0))

    expect(first.poll.currentIndex).toBe(1)
    expect(second.poll.currentIndex).toBe(1)
    // The third question must never have been made ready.
    expect(second.poll.readyAtByQ[poll.q[2]]).toBeUndefined()
  })

  it('ignores a Next carrying an index the room has already passed', async () => {
    const poll = await makePoll([CHOICE, TEXT, { ...CHOICE, prompt: 'Third?' }], 10)
    ok(await api.act(poll.id, 'start'))
    ok(await api.act(poll.id, 'next', 0))

    const stale = ok(await api.act(poll.id, 'next', 0))
    expect(stale.poll.currentIndex).toBe(1)
  })

  it('advances when the tapping device is level with the room', async () => {
    const poll = await makePoll([CHOICE, TEXT], 10)
    ok(await api.act(poll.id, 'start'))
    const next = ok(await api.act(poll.id, 'next', 0))
    expect(next.poll.currentIndex).toBe(1)
    expect(next.poll.readyAtByQ[poll.q[1]]).toBeGreaterThan(0)
  })
})

describe('reset', () => {
  it('returns the poll to draft, clears answers and keeps the questions', async () => {
    const poll = await makePoll([CHOICE, TEXT], 10)
    ok(await api.act(poll.id, 'start'))
    ok(await api.answer(poll.id, poll.q[0], device(1), poll.o[0][0]))

    const after = ok(await api.act(poll.id, 'reset'))
    expect(after.poll.phase).toBe('draft')
    expect(after.poll.currentIndex).toBe(-1)
    expect(after.poll.questions).toHaveLength(2)
    expect(Object.values(after.responseCounts).reduce((a, b) => a + b, 0)).toBe(0)
    expect(after.poll.readyAtByQ).toEqual({})
  })

  it('increments the run so the previous session is unreachable', async () => {
    const poll = await makePoll([CHOICE], 10)
    const before = ok(await api.snapshot(poll.id, 'create')).poll.run
    ok(await api.act(poll.id, 'start'))
    ok(await api.answer(poll.id, poll.q[0], device(1), poll.o[0][0]))

    const after = ok(await api.act(poll.id, 'reset'))
    expect(after.poll.run).toBe(before + 1)

    // Re-running must not resurrect last session's answers.
    ok(await api.act(poll.id, 'start'))
    expect(ok(await api.snapshot(poll.id, 'lead')).responseCounts[poll.q[0]]).toBe(0)
    expect(ok(await api.snapshot(poll.id, 'respond', device(1))).mine).toEqual({})
  })

  it('refuses answers once the poll is back in draft', async () => {
    const poll = await makePoll([CHOICE], 10)
    ok(await api.act(poll.id, 'start'))
    ok(await api.act(poll.id, 'reset'))

    const result = await api.answer(poll.id, poll.q[0], device(1), poll.o[0][0])
    expect(result.status).toBe(409)
  })
})

describe('validation and errors', () => {
  it('404s an unknown poll id', async () => {
    const result = await api.snapshot('zzzzzzz', 'lead')
    expect(result.status).toBe(404)
    expect(result.body.error).toMatch(/no poll/i)
  })

  it('404s an unknown question id', async () => {
    const poll = await makePoll([CHOICE], 10)
    ok(await api.act(poll.id, 'start'))
    const result = await api.answer(poll.id, 'nosuchq', device(1), poll.o[0][0])
    expect(result.status).toBe(404)
  })

  it('refuses edits while the poll is running', async () => {
    const poll = await makePoll([CHOICE], 10)
    ok(await api.act(poll.id, 'start'))

    const result = await api.save(poll.id, undefined, { questions: [] })
    expect(result.status).toBe(409)
    expect(result.body.error).toMatch(/reset the poll/i)
  })

  it('clamps duration, truncates text and de-duplicates ids', async () => {
    const { id } = ok(await api.create())
    const rev = ok(await api.snapshot(id, 'create')).poll.rev

    const saved = ok(
      await api.save(id, rev, {
        durationSec: 9999,
        title: 't'.repeat(500),
        questions: [
          {
            type: 'choice',
            prompt: 'x'.repeat(500),
            options: [
              { id: 'dup', text: 'a'.repeat(500) },
              { id: 'dup', text: 'b' },
            ],
          },
        ],
      }),
    )

    expect(saved.poll.durationSec).toBe(300)
    expect(saved.poll.title).toHaveLength(200)
    expect(saved.poll.questions[0].prompt).toHaveLength(200)
    const [first, second] = saved.poll.questions[0].options
    expect(first.id).not.toBe(second.id)
    expect(first.text).toHaveLength(80)
  })

  it('clamps duration upward from below the minimum', async () => {
    const poll = await makePoll([CHOICE], 0)
    expect(poll.poll.durationSec).toBe(1)
  })

  it('cannot be tricked into moving the poll through a draft save', async () => {
    // Run-state belongs to the server; a hostile payload must not move it.
    const poll = await makePoll([CHOICE], 10)
    const saved = ok(
      await api.save(poll.id, poll.poll.rev, {
        durationSec: 10,
        phase: 'active',
        currentIndex: 5,
        run: 99,
        readyAtByQ: { [poll.q[0]]: 1 },
        questions: [{ id: poll.q[0], type: 'choice', prompt: 'Best snack?', options: [] }],
      }),
    )

    expect(saved.poll.phase).toBe('draft')
    expect(saved.poll.currentIndex).toBe(-1)
    expect(saved.poll.run).toBe(poll.poll.run)
    expect(saved.poll.readyAtByQ).toEqual({})
  })

  it('rejects an unknown action', async () => {
    const poll = await makePoll([CHOICE], 10)
    const result = await api.act(poll.id, 'explode' as 'start')
    expect(result.status).toBe(400)
  })
})

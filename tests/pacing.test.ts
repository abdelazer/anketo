/**
 * Auto-advance is the one place where the app moves a respondent's screen for
 * them, so the cases it must *refuse* matter more than the case it accepts: a
 * phone that never answered still has a live offer to answer, and an open
 * countdown means the answer on screen can still be changed. Both are tested
 * here rather than through the DOM, because the decision is the whole feature.
 */
import { describe, expect, it } from 'vitest'
import { shouldAutoAdvance } from '../src/pacing'
import type { Phase, Poll, Snapshot } from '../shared/poll'

const READY_AT = 1_700_000_000_000
const DURATION = 20
/** One millisecond after the countdown on a question made Ready at READY_AT. */
const REVEALED = READY_AT + DURATION * 1000 + 1

interface Options {
  phase?: Phase
  currentIndex?: number
  /** Question ids this device has answered. */
  answered?: string[]
  /** Question ids the Leader has made Ready; defaults to all up to currentIndex. */
  ready?: string[]
}

function snapshotOf({ phase = 'active', currentIndex = 1, answered = ['q0'], ready }: Options = {}): Snapshot {
  const questions = ['q0', 'q1', 'q2'].map((id) => ({
    id,
    type: 'choice' as const,
    prompt: id,
    options: [{ id: `${id}a`, text: 'a' }, { id: `${id}b`, text: 'b' }],
  }))

  const readyIds = ready ?? questions.slice(0, currentIndex + 1).map((q) => q.id)

  const poll: Poll = {
    id: 'abcdefg',
    createdAt: READY_AT,
    updatedAt: READY_AT,
    rev: 1,
    run: 1,
    title: 'Test poll',
    durationSec: DURATION,
    questions,
    phase,
    currentIndex,
    readyAtByQ: Object.fromEntries(readyIds.map((id) => [id, READY_AT])),
  }

  return {
    serverTime: REVEALED,
    poll,
    responseCounts: {},
    tallies: {},
    mine: Object.fromEntries(answered.map((id) => [id, `${id}a`])),
  }
}

describe('auto-advance', () => {
  it('follows the room once this question is answered and locked', () => {
    expect(shouldAutoAdvance(snapshotOf(), 0, REVEALED)).toBe(true)
  })

  it('waits while the countdown is still running', () => {
    // The Leader has moved on early; the answer on screen is still changeable,
    // and taking the question away mid-change is the thing this must not do.
    expect(shouldAutoAdvance(snapshotOf(), 0, READY_AT + 1000)).toBe(false)
    // Exactly on the reveal boundary it goes, matching `isRevealed`.
    expect(shouldAutoAdvance(snapshotOf(), 0, READY_AT + DURATION * 1000)).toBe(true)
  })

  it('stays put on a question this device never answered', () => {
    // "Time is up, but you can still answer" is a real offer to a latecomer.
    // Advancing would withdraw it without them touching anything.
    expect(shouldAutoAdvance(snapshotOf({ answered: [] }), 0, REVEALED)).toBe(false)
  })

  it('stays put when the Leader has not moved on', () => {
    expect(shouldAutoAdvance(snapshotOf({ currentIndex: 0 }), 0, REVEALED)).toBe(false)
  })

  it('never runs ahead of the Leader', () => {
    // A stale persisted position must not turn into a walk to the end of the
    // poll: `currentIndex` is the ceiling, not a suggestion.
    expect(shouldAutoAdvance(snapshotOf({ currentIndex: 1 }), 1, REVEALED)).toBe(false)
    expect(shouldAutoAdvance(snapshotOf({ currentIndex: 1 }), 2, REVEALED)).toBe(false)
  })

  it('does nothing outside an active poll', () => {
    expect(shouldAutoAdvance(snapshotOf({ phase: 'draft' }), 0, REVEALED)).toBe(false)
    expect(shouldAutoAdvance(snapshotOf({ phase: 'complete' }), 0, REVEALED)).toBe(false)
  })

  it('does nothing from a position that is not a question', () => {
    expect(shouldAutoAdvance(snapshotOf(), -1, REVEALED)).toBe(false)
    expect(shouldAutoAdvance(snapshotOf({ currentIndex: 9 }), 5, REVEALED)).toBe(false)
  })

  it('stays put on a question that was never made Ready', () => {
    // No `readyAt` means no reveal time; a null there must not read as zero, or
    // an unasked question would count as locked and advance on its own.
    const snapshot = snapshotOf({ currentIndex: 1, ready: ['q1'] })
    expect(shouldAutoAdvance(snapshot, 0, REVEALED)).toBe(false)
  })

  it('survives a snapshot with no answers of its own', () => {
    const snapshot = snapshotOf()
    delete snapshot.mine
    expect(shouldAutoAdvance(snapshot, 0, REVEALED)).toBe(false)
  })
})

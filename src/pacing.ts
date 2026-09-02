/**
 * When a phone moves itself on.
 *
 * Respondents deliberately run behind the Leader — question 3 going Ready must
 * never yank question 2 out from under someone mid-answer. But once this phone
 * is *finished* with the question it is showing, staying put is just friction:
 * the room is already looking at the next one, and the responder is waiting on
 * a button they have to notice first.
 *
 * So the rule is narrow. Advance only when there is nothing left to do here:
 * the Leader is ahead, this device has an answer recorded, and the countdown
 * has run out so that answer can no longer be changed. Every other case keeps
 * its place and its manual Next button.
 */
import { isRevealed, type Snapshot } from '../shared/poll'

/**
 * How long "Answer locked in" stays on screen before the phone follows the
 * room. Long enough to read as a confirmation, short enough that nobody
 * reaches for the button first.
 */
export const ADVANCE_AFTER_MS = 1200

/** Whether the phone showing `viewIndex` should move to the next question. */
export function shouldAutoAdvance(snapshot: Snapshot, viewIndex: number, now: number): boolean {
  const { poll } = snapshot
  if (poll.phase !== 'active') return false

  // Nothing to advance to: this phone is already level with the Leader.
  if (viewIndex < 0 || viewIndex >= poll.currentIndex) return false

  const question = poll.questions[viewIndex]
  if (!question) return false

  // A phone that never answered keeps its place. "Time is up, but you can
  // still answer" is a real offer, and advancing would quietly withdraw it.
  if (snapshot.mine?.[question.id] === undefined) return false

  // Never take an open question away from someone who may still be changing
  // their answer to it.
  return isRevealed(poll, question.id, now)
}

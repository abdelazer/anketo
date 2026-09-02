import { api } from '../api'
import { deviceId, safeGet, safeSet, seededShuffle } from '../device'
import { h, replace, setText, toast } from '../dom'
import { PollStore } from '../store'
import { questionFace } from './question'
import { brand, errorScreen, spinner } from './shell'
import { isRevealed, secondsLeft, type Snapshot } from '../../shared/poll'

/**
 * Respond mode — one person, one phone.
 *
 * Respondents move through the poll at their own pace behind the Leader: the
 * Leader making question 3 Ready never yanks question 2 out from under someone
 * mid-answer. They get a Next button instead, exactly as specified.
 */
export function mountRespond(root: HTMLElement, pollId: string): () => void {
  const device = deviceId()
  const store = new PollStore(pollId, 'respond', device)
  const positionKey = `anketo:at:${pollId}`

  /** Which question this phone is looking at; never ahead of the Leader. */
  let viewIndex = Number(safeGet(positionKey) ?? '-1')
  let sceneKey = ''
  let pending: string | null = null
  /** Which question the stage is currently showing, for reading its answer box. */
  let staged: string | null = null
  /**
   * Text typed into the answer box but not sent yet. A scene rebuild replaces
   * the textarea, so the unsent text has to be read off the old one first or a
   * half-written answer vanishes when the timer expires mid-sentence.
   */
  let draft: { questionId: string; value: string } | null = null

  const stage = h('div', { class: 'grow stage' })
  const bottom = h('div', { class: 'respond-bottom' })
  const screen = h(
    'div',
    { class: 'screen respond' },
    h(
      'div',
      { class: 'topbar' },
      brand(),
      h('span', { class: 'spacer' }),
      h('span', { class: 'pill', id: 'respond-progress' }),
    ),
    stage,
    bottom,
  )

  root.appendChild(spinner('Joining…'))

  function setIndex(index: number): void {
    viewIndex = index
    safeSet(positionKey, String(index))
  }

  // --- Scene selection -----------------------------------------------------

  function sceneFor(snapshot: Snapshot): string {
    const { poll } = snapshot
    if (poll.phase === 'draft') return 'waiting'
    if (poll.phase === 'complete') return 'done'

    // A phone that joins late lands on the question the room is actually on,
    // rather than four expired questions back.
    if (viewIndex < 0 || viewIndex > poll.currentIndex) setIndex(poll.currentIndex)

    const question = poll.questions[viewIndex]
    if (!question) return 'waiting'

    const mine = snapshot.mine?.[question.id]
    const locked = isRevealed(poll, question.id, store.serverNow())
    return `q:${question.id}:${mine ?? ''}:${locked ? 'locked' : 'open'}`
  }

  function render(snapshot: Snapshot): void {
    if (root.firstChild !== screen) replace(root, screen)

    const key = sceneFor(snapshot)
    if (key !== sceneKey) {
      captureDraft()
      sceneKey = key
      buildScene(snapshot, key)
    }
    patchScene(snapshot, key)
  }

  /** Read the answer box before it is torn down, against the question it belongs to. */
  function captureDraft(): void {
    const input = stage.querySelector<HTMLTextAreaElement>('textarea.text-answer')
    if (staged && input) draft = { questionId: staged, value: input.value }
  }

  function buildScene(snapshot: Snapshot, key: string): void {
    const { poll } = snapshot
    staged = null

    if (key === 'waiting') {
      replace(
        stage,
        h(
          'div',
          { class: 'centered' },
          h('div', { class: 'pulse', 'aria-hidden': 'true' }),
          h('h1', { class: 'display-sm', text: 'Waiting for the leader to start' }),
          poll.title && h('p', { class: 'muted', text: poll.title }),
        ),
      )
      replace(bottom)
      return
    }

    if (key === 'done') {
      replace(
        stage,
        h(
          'div',
          { class: 'centered' },
          h('div', { class: 'tick', 'aria-hidden': 'true' }, '✓'),
          h('h1', { class: 'display-sm', text: 'All done' }),
          h('p', { class: 'muted', text: 'Thanks for answering. Results are on the shared screen.' }),
        ),
      )
      replace(bottom)
      return
    }

    const question = poll.questions[viewIndex]
    if (!question) return

    const mine = snapshot.mine?.[question.id]
    const locked = isRevealed(poll, question.id, store.serverNow())
    // Whatever is in the box wins: it is either the answer being sent, the one
    // already sent, or an edit of it that no other source knows about yet.
    const typed = draft?.questionId === question.id ? draft.value : undefined
    staged = question.id

    replace(
      stage,
      questionFace(question, {
        interactive: true,
        // Seeded on the device so the order is stable for this person across
        // re-renders and refreshes, but different from their neighbour's.
        options: seededShuffle(question.options, `${device}:${question.id}`),
        // Both faces show the optimistic answer: a typed answer must survive in
        // the box until the POST lands, or a failed send leaves nothing to retry.
        selected: pending ?? mine,
        textValue: typed ?? pending ?? mine,
        answered: (pending ?? mine) !== undefined,
        // A locked question stays readable but stops accepting changes.
        disabled: locked && mine !== undefined,
        onChoose: (optionId) => void submit(question.id, optionId),
        onText: (value) => void submit(question.id, value),
      }),
    )

    replace(bottom, h('div', { class: 'stack stack--tight respond-foot' }))
  }

  function patchScene(snapshot: Snapshot, key: string): void {
    const { poll } = snapshot

    const progress = screen.querySelector('#respond-progress')
    if (progress) {
      setText(
        progress,
        poll.phase === 'active' && poll.questions[viewIndex]
          ? `Question ${viewIndex + 1} of ${poll.questions.length}`
          : '',
      )
    }

    if (!key.startsWith('q:')) return
    const question = poll.questions[viewIndex]
    if (!question) return

    const foot = bottom.querySelector('.respond-foot')
    if (!foot) return

    const mine = snapshot.mine?.[question.id]
    const locked = isRevealed(poll, question.id, store.serverNow())
    const left = secondsLeft(poll, question.id, store.serverNow())
    const hasNext = viewIndex < poll.currentIndex

    // Rebuild the footer only when its shape changes; the timer text is patched
    // in place so it does not flicker every 200ms.
    const shape = `${locked}:${mine !== undefined}:${hasNext}`
    if (foot.getAttribute('data-shape') !== shape) {
      foot.setAttribute('data-shape', shape)
      replace(
        foot,
        mine !== undefined &&
          h(
            'p',
            { class: 'answer-state' },
            h('span', { class: 'tick tick--sm', 'aria-hidden': 'true' }, '✓'),
            locked ? 'Answer locked in' : 'Answer sent — tap again to change it',
          ),
        !locked && h('div', { class: 'mini-timer' }, h('div', { class: 'mini-timer-fill' })),
        !locked && h('p', { class: 'mini-timer-label muted small' }),
        // A latecomer may still answer a question whose timer has run out, so
        // only say "waiting" to someone who has actually answered it.
        locked &&
          mine === undefined &&
          h('p', { class: 'muted small', text: 'Time is up, but you can still answer.' }),
        locked &&
          mine !== undefined &&
          !hasNext &&
          h('p', { class: 'muted small', text: 'Waiting for the next question…' }),
        hasNext &&
          h(
            'button',
            {
              class: 'btn btn--primary btn--block btn--big',
              type: 'button',
              on: {
                click: () => {
                  setIndex(Math.min(viewIndex + 1, poll.currentIndex))
                  pending = null
                  sceneKey = ''
                  render(snapshot)
                  store.quicken()
                },
              },
            },
            'Next question',
          ),
      )
    }

    const fill = foot.querySelector<HTMLElement>('.mini-timer-fill')
    if (fill) fill.style.width = `${Math.max(0, Math.min(1, left / poll.durationSec)) * 100}%`
    const label = foot.querySelector('.mini-timer-label')
    if (label) setText(label, left > 0 ? `${left}s left to answer` : 'Time is up')

    if (!locked && left === 0) void store.refresh()
  }

  // --- Submitting ----------------------------------------------------------

  async function submit(questionId: string, value: string): Promise<void> {
    const previous = pending
    pending = value
    // Paint the selection immediately — a phone on conference wifi should not
    // feel like the tap missed.
    if (store.snapshot) {
      sceneKey = ''
      render(store.snapshot)
    }
    try {
      store.apply(await api.answer(pollId, questionId, device, value))
      pending = null
    } catch (error) {
      pending = previous
      toast((error as Error).message, 'error')
      await store.refresh()
      if (store.snapshot) {
        sceneKey = ''
        render(store.snapshot)
      }
    }
  }

  // --- Wiring --------------------------------------------------------------

  const unsubscribe = store.subscribe((snapshot) => {
    if (store.error) {
      replace(
        root,
        errorScreen(store.error, h('a', { class: 'btn btn--primary', href: '/', text: 'Start your own poll' })),
      )
      return
    }
    render(snapshot)
  })

  const untick = store.onTick(() => {
    const snapshot = store.snapshot
    if (!snapshot || store.error) return
    const key = sceneFor(snapshot)
    if (key !== sceneKey) render(snapshot)
    else patchScene(snapshot, key)
  })

  store.start()

  return () => {
    untick()
    unsubscribe()
    store.stop()
  }
}

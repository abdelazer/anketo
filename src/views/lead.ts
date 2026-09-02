import { api } from '../api'
import { h, replace, setText, shareLink, toast } from '../dom'
import { qrSvg } from '../qr'
import { navigate, pollUrl } from '../router'
import { PollStore } from '../store'
import { renderTally } from '../viz/results'
import { questionFace } from './question'
import { brand, errorScreen, spinner } from './shell'
import { isRevealed, revealAt, secondsLeft, type Snapshot } from '../../shared/poll'

/**
 * Lead mode — the shared screen.
 *
 * Every device in Lead mode derives what to show from the snapshot plus server
 * time alone. There is no local "showing results" flag, which is precisely why
 * a laptop on the projector and a phone in the presenter's hand stay in step:
 * they are computing the same function of the same data, not exchanging
 * messages about it.
 */
export function mountLead(root: HTMLElement, pollId: string): () => void {
  const store = new PollStore(pollId, 'lead')
  const respondHref = pollUrl(pollId, 'respond')

  let sceneKey = ''
  let tallyKey = ''
  let acting = false

  const stage = h('div', { class: 'grow stage' })
  const bottom = h('div', { class: 'lead-bottom' })
  const screen = h(
    'div',
    { class: 'screen screen--wide lead' },
    h(
      'div',
      { class: 'topbar' },
      brand(),
      h('span', { class: 'spacer' }),
      h('span', { class: 'pill', id: 'lead-progress' }),
    ),
    stage,
    bottom,
  )

  root.appendChild(spinner('Loading poll…'))

  // --- Leader actions ------------------------------------------------------

  async function act(action: 'start' | 'next' | 'complete', index?: number): Promise<void> {
    if (acting) return
    acting = true
    try {
      store.apply(await api.act(pollId, action, index))
    } catch (error) {
      toast((error as Error).message, 'error')
      void store.refresh()
    } finally {
      acting = false
    }
  }

  // --- Scenes --------------------------------------------------------------

  function sceneFor(snapshot: Snapshot): string {
    const { poll } = snapshot
    if (poll.phase === 'draft') return 'lobby'
    if (poll.phase === 'complete') return 'summary'
    const question = poll.questions[poll.currentIndex]
    if (!question) return 'summary'
    const revealed = isRevealed(poll, question.id, store.serverNow())
    return `q:${question.id}:${revealed ? 'results' : 'asking'}`
  }

  function render(snapshot: Snapshot): void {
    if (root.firstChild !== screen) replace(root, screen)

    const key = sceneFor(snapshot)
    if (key !== sceneKey) {
      sceneKey = key
      tallyKey = ''
      buildScene(snapshot, key)
    }
    patchScene(snapshot, key)
  }

  function buildScene(snapshot: Snapshot, key: string): void {
    const { poll } = snapshot

    if (key === 'lobby') {
      replace(stage, lobby(snapshot))
      replace(
        bottom,
        h(
          'button',
          {
            class: 'btn btn--primary btn--block btn--big',
            type: 'button',
            disabled: poll.questions.length === 0,
            on: { click: () => void act('start') },
          },
          'Start poll',
        ),
      )
      return
    }

    if (key === 'summary') {
      replace(stage, summary(snapshot))
      replace(
        bottom,
        h(
          'div',
          { class: 'row row--wrap' },
          h(
            'button',
            {
              class: 'btn btn--ghost',
              type: 'button',
              on: { click: () => navigate(`/p/${pollId}/create`) },
            },
            'Edit poll',
          ),
          h('span', { class: 'spacer' }),
          h(
            'button',
            {
              class: 'btn btn--primary',
              type: 'button',
              on: {
                click: async () => {
                  if (!confirm('Run this poll again? All answers will be cleared.')) return
                  try {
                    store.apply(await api.act(pollId, 'reset'))
                  } catch (error) {
                    toast((error as Error).message, 'error')
                  }
                },
              },
            },
            'Run again',
          ),
        ),
      )
      return
    }

    const question = poll.questions[poll.currentIndex]
    if (!question) return
    const asking = key.endsWith(':asking')

    if (asking) {
      // Deliberately the same component the room sees, minus interactivity.
      replace(stage, questionFace(question, { interactive: false }))
      replace(
        bottom,
        h(
          'div',
          { class: 'countdown', id: 'countdown' },
          h('div', { class: 'countdown-track' }, h('div', { class: 'countdown-fill' })),
          h(
            'div',
            { class: 'row countdown-row' },
            h('span', { class: 'countdown-num', text: '—' }),
            h('span', { class: 'countdown-label', text: 'seconds to answer' }),
            h('span', { class: 'spacer' }),
            h('span', { class: 'countdown-count muted', text: '' }),
          ),
        ),
      )
      return
    }

    replace(
      stage,
      h(
        'div',
        { class: 'results-stage' },
        h('h2', { class: 'prompt prompt--result', text: question.prompt }),
        h('div', { class: 'result-body' }),
        h('p', { class: 'muted small result-total', text: '' }),
      ),
    )

    const last = poll.currentIndex >= poll.questions.length - 1
    replace(
      bottom,
      h(
        'button',
        {
          class: 'btn btn--primary btn--block btn--big',
          type: 'button',
          on: {
            click: () =>
              void (last ? act('complete') : act('next', poll.currentIndex)),
          },
        },
        last ? 'Complete poll' : 'Next question',
      ),
    )
  }

  function patchScene(snapshot: Snapshot, key: string): void {
    const { poll } = snapshot

    const progress = screen.querySelector('#lead-progress')
    if (progress) {
      setText(
        progress,
        poll.phase === 'active'
          ? `Question ${poll.currentIndex + 1} of ${poll.questions.length}`
          : poll.phase === 'complete'
            ? 'Finished'
            : `${poll.questions.length} question${poll.questions.length === 1 ? '' : 's'}`,
      )
    }

    const question = poll.questions[poll.currentIndex]
    if (!question) return

    if (key.endsWith(':asking')) {
      const left = secondsLeft(poll, question.id, store.serverNow())
      const total = poll.durationSec
      const num = bottom.querySelector('.countdown-num')
      const fill = bottom.querySelector<HTMLElement>('.countdown-fill')
      const count = bottom.querySelector('.countdown-count')

      if (num) setText(num, String(left))
      if (fill) fill.style.width = `${Math.max(0, Math.min(1, left / total)) * 100}%`
      if (count) {
        const n = snapshot.responseCounts[question.id] ?? 0
        // A bare count during the countdown; the distribution stays server-side.
        setText(count, n === 0 ? 'no answers yet' : `${n} answered`)
      }

      // The scene flips on its own the instant the clock runs out, even if the
      // next fetch has not landed yet.
      if (left === 0) {
        const at = revealAt(poll, question.id)
        if (at !== null && store.serverNow() >= at) {
          render(snapshot)
          void store.refresh()
        }
      }
      return
    }

    if (key.endsWith(':results')) {
      const tally = snapshot.tallies[question.id]
      const body = stage.querySelector('.result-body')
      const total = stage.querySelector('.result-total')
      if (!body) return

      if (!tally) {
        // Timer expired locally but the revealed tally has not arrived yet.
        if (!body.firstChild) replace(body, h('p', { class: 'empty', text: 'Collecting answers…' }))
        return
      }

      const next = JSON.stringify(tally)
      if (next !== tallyKey) {
        tallyKey = next
        replace(body, renderTally(tally))
      }
      if (total) {
        setText(
          total,
          tally.total === 0
            ? 'No answers'
            : `${tally.total} answer${tally.total === 1 ? '' : 's'}`,
        )
      }
    }
  }

  // --- Lobby and summary ---------------------------------------------------

  function lobby(snapshot: Snapshot): HTMLElement {
    return h(
      'div',
      { class: 'lobby' },
      h('p', { class: 'eyebrow', text: 'Scan to join' }),
      h('div', { class: 'qr-frame' }, qrSvg(respondHref, { title: 'Scan to join this poll' })),
      h(
        'div',
        { class: 'stack stack--tight join-links' },
        h('p', { class: 'join-url', text: respondHref.replace(/^https?:\/\//, '') }),
        h(
          'button',
          {
            class: 'btn btn--ghost',
            type: 'button',
            on: { click: () => void shareLink(respondHref, 'Join this poll') },
          },
          'Share join link',
        ),
      ),
      snapshot.poll.title && h('p', { class: 'lobby-title', text: snapshot.poll.title }),
    )
  }

  function summary(snapshot: Snapshot): HTMLElement {
    const { poll } = snapshot
    return h(
      'div',
      { class: 'stack summary' },
      h('h1', { class: 'display-sm', text: poll.title || 'Poll complete' }),
      ...poll.questions.map((question, index) => {
        const tally = snapshot.tallies[question.id]
        return h(
          'section',
          { class: 'card stack' },
          h('p', { class: 'eyebrow', text: `Question ${index + 1}` }),
          h('h2', { class: 'prompt prompt--small', text: question.prompt }),
          tally
            ? renderTally(tally)
            : h('p', { class: 'empty', text: 'Never shown to the room.' }),
        )
      }),
    )
  }

  // --- Wiring --------------------------------------------------------------

  const unsubscribe = store.subscribe((snapshot) => {
    if (store.error) {
      replace(
        root,
        errorScreen(store.error, h('a', { class: 'btn btn--primary', href: '/', text: 'Start a new poll' })),
      )
      return
    }
    render(snapshot)
  })

  const untick = store.onTick(() => {
    const snapshot = store.snapshot
    if (!snapshot || store.error) return
    // Re-checking the scene every tick is what makes the countdown → results
    // transition land on time on both Lead devices at once.
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

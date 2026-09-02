import { api, ApiError } from '../api'
import { h, replace, setText, shareLink, toast } from '../dom'
import { navigate, pollUrl } from '../router'
import { PollStore } from '../store'
import { brand, errorScreen, spinner } from './shell'
import {
  MAX_DURATION,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_DURATION,
  type Poll,
  type Question,
} from '../../shared/poll'

const SAVE_DEBOUNCE_MS = 600

/** Ids only have to be unique inside one poll; the server re-checks anyway. */
const localId = () => Math.random().toString(36).slice(2, 8)

export function mountCreate(root: HTMLElement, pollId: string): () => void {
  const store = new PollStore(pollId, 'create')

  let draft: Poll | null = null
  /** Bumped by every edit; a save only clears the flag for what it actually sent. */
  let edits = 0
  let savedEdits = 0
  let inFlight: Promise<void> | null = null
  let saveTimer: number | undefined
  let disposed = false

  const dirty = () => edits !== savedEdits

  const status = h('span', { class: 'save-status', text: '' })
  const questionList = h('div', { class: 'stack' })
  const setupCard = h('div', { class: 'card stack' })
  const footer = h('div', { class: 'sticky-bar' })
  const banner = h('div', { class: 'banner', hidden: true })

  const screen = h(
    'div',
    { class: 'screen' },
    h('div', { class: 'topbar' }, brand(), h('span', { class: 'spacer' }), status),
    banner,
    setupCard,
    h('div', { class: 'grow stack' }, questionList, addRow()),
    utilityRow(),
    footer,
  )

  root.appendChild(spinner('Loading your poll…'))

  // --- Saving --------------------------------------------------------------

  function markDirty(): void {
    edits++
    setText(status, 'Saving…')
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => void save(), SAVE_DEBOUNCE_MS)
  }

  async function save(): Promise<void> {
    // A caller that arrives mid-request waits for it rather than dropping its
    // edit on the floor; the follow-up below is what actually sends that edit.
    if (inFlight) return inFlight
    if (!draft || !dirty() || disposed) return

    const attempted = draft
    // Only the edits made before the request went out are covered by it.
    const sent = edits
    let sendAgain = false

    inFlight = (async () => {
      try {
        const snapshot = await api.save(pollId, attempted.rev, {
          title: attempted.title,
          durationSec: attempted.durationSec,
          questions: attempted.questions,
        })
        // Take the server's new revision so the next save's CAS matches, but
        // in place: the live DOM handlers write straight into this object, and
        // the user may have typed during the round trip.
        if (draft === attempted) attempted.rev = snapshot.poll.rev
        savedEdits = sent
        store.apply(snapshot)
        sendAgain = dirty()
        setText(status, sendAgain ? 'Saving…' : 'Saved')
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          // Another device won. Theirs is authoritative; take it and say so.
          savedEdits = edits
          await store.refresh()
          if (store.snapshot) adopt(store.snapshot.poll, { force: true })
          showBanner(error.message + ' Reloaded the latest version.')
          setText(status, '')
        } else {
          setText(status, 'Offline — will retry')
          window.clearTimeout(saveTimer)
          saveTimer = window.setTimeout(() => void save(), 3000)
        }
      }
    })()

    try {
      await inFlight
    } finally {
      inFlight = null
    }

    // Anything typed while that request was open is still only on this device.
    if (sendAgain && !disposed) {
      window.clearTimeout(saveTimer)
      await save()
    }
  }

  /** Push any pending edit before an action that depends on it landing. */
  async function flush(): Promise<void> {
    window.clearTimeout(saveTimer)
    // An open request may predate the newest edit, so wait it out before
    // deciding — never navigate away on the strength of a PUT already in air.
    if (inFlight) await inFlight.catch(() => {})
    if (dirty()) await save()
  }

  function showBanner(message: string): void {
    setText(banner, message)
    banner.hidden = false
  }

  // --- Rendering -----------------------------------------------------------

  function adopt(poll: Poll, options: { force?: boolean } = {}): void {
    // Never let a poll fetch overwrite what someone is in the middle of typing.
    if (!options.force && dirty()) return
    if (!options.force && draft && poll.rev === draft.rev) return
    draft = structuredClone(poll)
    render()
  }

  function render(): void {
    if (!draft) return
    const locked = draft.phase !== 'draft'

    if (root.firstChild !== screen) replace(root, screen)

    renderSetup(locked)
    renderQuestions(locked)
    renderFooter(locked)
  }

  function renderSetup(locked: boolean): void {
    if (!draft) return
    const poll = draft

    const title = h('input', {
      class: 'field field--prompt',
      value: poll.title,
      placeholder: 'Poll name (optional)',
      maxlength: '200',
      disabled: locked,
      'aria-label': 'Poll name',
      on: {
        input: (event) => {
          poll.title = (event.target as HTMLInputElement).value
          markDirty()
        },
      },
    })

    const seconds = h('input', {
      class: 'field field--stepper',
      type: 'number',
      inputmode: 'numeric',
      min: String(MIN_DURATION),
      max: String(MAX_DURATION),
      value: String(poll.durationSec),
      disabled: locked,
      'aria-label': `Seconds to answer, ${MIN_DURATION} to ${MAX_DURATION}`,
      on: {
        input: (event) => {
          const raw = Number((event.target as HTMLInputElement).value)
          if (!Number.isFinite(raw)) return
          poll.durationSec = clampDuration(raw)
          markDirty()
        },
        blur: (event) => {
          poll.durationSec = clampDuration(Number((event.target as HTMLInputElement).value))
          ;(event.target as HTMLInputElement).value = String(poll.durationSec)
          markDirty()
        },
      },
    })

    const nudge = (delta: number) =>
      h(
        'button',
        {
          class: 'btn btn--ghost btn--step',
          type: 'button',
          disabled: locked,
          'aria-label': delta > 0 ? 'Add five seconds' : 'Remove five seconds',
          on: {
            click: () => {
              poll.durationSec = clampDuration(poll.durationSec + delta)
              seconds.value = String(poll.durationSec)
              markDirty()
            },
          },
        },
        delta > 0 ? '+5' : '−5',
      )

    replace(
      setupCard,
      title,
      h(
        'div',
        { class: 'row row--wrap' },
        h('span', { class: 'label', text: 'Time to answer each question' }),
        h('span', { class: 'spacer' }),
        h('div', { class: 'stepper' }, nudge(-5), seconds, nudge(5)),
        h('span', { class: 'muted', text: 'sec' }),
      ),
    )
  }

  function renderQuestions(locked: boolean): void {
    if (!draft) return
    const poll = draft
    replace(
      questionList,
      ...poll.questions.map((question, index) =>
        questionCard(question, index, poll.questions.length, locked),
      ),
      poll.questions.length === 0 &&
        h('p', { class: 'empty', text: 'No questions yet — add one below.' }),
    )
  }

  function questionCard(
    question: Question,
    index: number,
    total: number,
    locked: boolean,
  ): HTMLElement {
    const move = (delta: number) => () => {
      if (!draft) return
      const target = index + delta
      if (target < 0 || target >= draft.questions.length) return
      const list = draft.questions
      ;[list[index], list[target]] = [list[target], list[index]]
      markDirty()
      renderQuestions(locked)
    }

    const setType = (type: Question['type']) => () => {
      if (question.type === type) return
      question.type = type
      // Give a fresh choice question somewhere to type, but keep any options
      // the author already wrote if they toggle back and forth.
      if (type === 'choice' && question.options.length === 0) {
        question.options = [blankOption(), blankOption()]
      }
      markDirty()
      renderQuestions(locked)
    }

    return h(
      'section',
      { class: 'card stack q-card' },
      h(
        'div',
        { class: 'row q-head' },
        h('span', { class: 'q-number', text: `Q${index + 1}` }),
        h(
          'div',
          { class: 'segmented', role: 'group', 'aria-label': 'Question type' },
          segButton('Choice', question.type === 'choice', locked, setType('choice')),
          segButton('Text', question.type === 'text', locked, setType('text')),
        ),
        h('span', { class: 'spacer' }),
        iconButton('Move up', '↑', locked || index === 0, move(-1)),
        iconButton('Move down', '↓', locked || index === total - 1, move(1)),
        iconButton('Delete question', '✕', locked, () => {
          if (!draft) return
          draft.questions.splice(index, 1)
          markDirty()
          renderQuestions(locked)
        }),
      ),
      h('input', {
        class: 'field field--prompt',
        value: question.prompt,
        placeholder: 'What do you want to ask?',
        maxlength: '200',
        disabled: locked,
        'aria-label': `Question ${index + 1} prompt`,
        on: {
          input: (event) => {
            question.prompt = (event.target as HTMLInputElement).value
            markDirty()
          },
        },
      }),
      question.type === 'choice'
        ? h(
            'div',
            { class: 'stack stack--tight' },
            ...question.options.map((option, oi) =>
              h(
                'div',
                { class: 'row option-row' },
                h('span', { class: 'option-dot', 'aria-hidden': 'true' }),
                h('input', {
                  class: 'field',
                  value: option.text,
                  placeholder: `Option ${oi + 1}`,
                  maxlength: '80',
                  disabled: locked,
                  'aria-label': `Question ${index + 1}, option ${oi + 1}`,
                  on: {
                    input: (event) => {
                      option.text = (event.target as HTMLInputElement).value
                      markDirty()
                    },
                  },
                }),
                iconButton('Remove option', '✕', locked || question.options.length <= 2, () => {
                  question.options.splice(oi, 1)
                  markDirty()
                  renderQuestions(locked)
                }),
              ),
            ),
            h(
              'button',
              {
                class: 'btn btn--quiet',
                type: 'button',
                disabled: locked || question.options.length >= MAX_OPTIONS,
                on: {
                  click: () => {
                    question.options.push(blankOption())
                    markDirty()
                    renderQuestions(locked)
                  },
                },
              },
              '+ Add option',
            ),
          )
        : h('p', { class: 'muted small', text: 'People will type a short answer.' }),
    )
  }

  function addRow(): HTMLElement {
    const add = (type: Question['type'], label: string) =>
      h(
        'button',
        {
          class: 'btn btn--ghost btn--block',
          type: 'button',
          on: {
            click: () => {
              if (!draft || draft.phase !== 'draft') return
              if (draft.questions.length >= MAX_QUESTIONS) {
                toast(`That is the limit of ${MAX_QUESTIONS} questions.`, 'error')
                return
              }
              draft.questions.push({
                id: localId(),
                type,
                prompt: '',
                options: type === 'choice' ? [blankOption(), blankOption()] : [],
              })
              markDirty()
              renderQuestions(false)
              // Drop the caret straight into the new prompt.
              const cards = questionList.querySelectorAll<HTMLInputElement>('.field--prompt')
              cards[cards.length - 1]?.focus()
            },
          },
        },
        label,
      )

    return h('div', { class: 'row add-row' }, add('choice', '+ Choice'), add('text', '+ Text'))
  }

  /**
   * Duplicate is the only editing move available once a poll has started:
   * Create locks at Start Poll, and the alternative — Reset — buys an editable
   * poll by destroying the answers. A copy keeps both.
   */
  function duplicateButton(): HTMLButtonElement {
    const button = h(
      'button',
      {
        class: 'btn btn--ghost',
        type: 'button',
        title: 'Start a new draft with the same questions',
        on: {
          click: async () => {
            button.disabled = true
            setText(button, 'Duplicating…')
            const restore = () => {
              button.disabled = false
              setText(button, 'Duplicate')
            }
            try {
              // The server copies what is *stored*, so anything still sitting in
              // the save debounce has to land first or the copy misses it.
              await flush()
              if (dirty()) {
                toast('Your latest edits have not saved yet — try again in a moment.', 'error')
                restore()
                return
              }
              const { id } = await api.create(pollId)
              navigate(`/p/${id}/create`)
            } catch (error) {
              toast((error as Error).message, 'error')
              restore()
            }
          },
        },
      },
      'Duplicate',
    )
    return button
  }

  function utilityRow(): HTMLElement {
    return h(
      'div',
      { class: 'row row--wrap util-row' },
      h(
        'button',
        {
          class: 'btn btn--ghost',
          type: 'button',
          on: { click: () => void shareLink(pollUrl(pollId, 'create'), 'Edit this poll') },
        },
        'Share edit link',
      ),
      duplicateButton(),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn btn--danger',
          type: 'button',
          on: {
            click: async () => {
              const answered = Object.values(store.snapshot?.responseCounts ?? {}).reduce(
                (a, b) => a + b,
                0,
              )
              const confirmed = confirm(
                answered > 0
                  ? `Delete all ${answered} answers and return this poll to draft?`
                  : 'Return this poll to draft and clear any answers?',
              )
              if (!confirmed) return
              try {
                store.apply(await api.act(pollId, 'reset'))
                if (store.snapshot) adopt(store.snapshot.poll, { force: true })
                toast('Answers cleared')
              } catch (error) {
                toast((error as Error).message, 'error')
              }
            },
          },
        },
        'Reset all answers',
      ),
    )
  }

  function renderFooter(locked: boolean): void {
    const answered = Object.values(store.snapshot?.responseCounts ?? {}).reduce((a, b) => a + b, 0)

    replace(
      footer,
      locked
        ? h(
            'div',
            { class: 'stack stack--tight' },
            h('p', {
              class: 'small secondary-text',
              text:
                store.snapshot?.poll.phase === 'complete'
                  ? 'This poll has finished. Reset it to run it again, or duplicate it to keep these results.'
                  : `This poll is running${answered ? ` — ${answered} answers so far` : ''}. Reset it to edit, or duplicate it.`,
            }),
            h('a', {
              class: 'btn btn--primary btn--block btn--big',
              href: pollUrl(pollId, 'lead'),
              text: 'Open Lead mode',
              on: {
                click: (event: Event) => {
                  event.preventDefault()
                  navigate(`/p/${pollId}/lead`)
                },
              },
            }),
          )
        : h(
            'button',
            {
              class: 'btn btn--primary btn--block btn--big',
              type: 'button',
              on: {
                click: async () => {
                  await flush()
                  navigate(`/p/${pollId}/lead`)
                },
              },
            },
            'Lead poll now',
          ),
    )
  }

  // --- Wiring --------------------------------------------------------------

  const unsubscribe = store.subscribe((snapshot) => {
    if (store.error) {
      replace(root, errorScreen(store.error, h('a', { class: 'btn btn--primary', href: '/', text: 'Start a new poll' })))
      return
    }
    adopt(snapshot.poll)
    if (draft) renderFooter(draft.phase !== 'draft')
  })

  // A last-ditch save when the tab goes away mid-edit.
  const onHide = () => {
    if (dirty()) void save()
  }
  window.addEventListener('pagehide', onHide)
  document.addEventListener('visibilitychange', onHide)

  store.start()

  return () => {
    disposed = true
    window.clearTimeout(saveTimer)
    window.removeEventListener('pagehide', onHide)
    document.removeEventListener('visibilitychange', onHide)
    unsubscribe()
    store.stop()
  }
}

function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return MIN_DURATION
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(value)))
}

function blankOption() {
  return { id: localId(), text: '' }
}

function segButton(
  label: string,
  active: boolean,
  disabled: boolean,
  onClick: () => void,
): HTMLElement {
  return h(
    'button',
    {
      class: active ? 'seg seg--on' : 'seg',
      type: 'button',
      disabled,
      'aria-pressed': String(active),
      on: { click: onClick },
    },
    label,
  )
}

function iconButton(
  label: string,
  glyph: string,
  disabled: boolean,
  onClick: () => void,
): HTMLElement {
  return h(
    'button',
    {
      class: 'btn btn--icon',
      type: 'button',
      disabled,
      title: label,
      'aria-label': label,
      on: { click: onClick },
    },
    glyph,
  )
}

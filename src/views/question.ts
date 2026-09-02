import { h } from '../dom'
import { grownField } from './fields'
import { MAX_TEXT_ANSWER_LEN, type Question } from '../../shared/poll'

/**
 * The question face, shared by Lead and Respond.
 *
 * Lead renders it with `interactive: false` so the projected screen is a pixel
 * match for what the room has in their hands — same prompt, same option cards,
 * nothing tappable.
 */
export interface QuestionFaceOptions {
  interactive: boolean
  options?: Question['options']
  selected?: string
  textValue?: string
  /** Whether an answer is actually on record, as opposed to text merely sitting
   * in the box. Defaults to the latter when not given. */
  answered?: boolean
  onChoose?: (optionId: string) => void
  onText?: (value: string) => void
  disabled?: boolean
}

export function questionFace(question: Question, config: QuestionFaceOptions): HTMLElement {
  const options = config.options ?? question.options

  const body =
    question.type === 'choice'
      ? h(
          'div',
          { class: 'options', role: config.interactive ? 'radiogroup' : 'list' },
          ...options.map((option) => optionCard(option, config)),
        )
      : textBody(config)

  return h(
    'div',
    { class: 'question-face' },
    h('h1', { class: promptClass(question.prompt), text: question.prompt }),
    body,
  )
}

/**
 * The prompt's type scale, by length.
 *
 * The default size is chosen to fill a projected screen, which is right for
 * "Best snack?" and wrong for a three-line question: at that size a long
 * prompt pushes the options off the bottom of the stage, where nobody in the
 * room can scroll to them and nobody on a phone can see them without hunting.
 * So the ceiling comes down as the prompt gets longer — still readable from
 * the back of the room, with the answers still on screen underneath it.
 */
function promptClass(prompt: string): string {
  if (prompt.length > 200) return 'prompt prompt--dense'
  if (prompt.length > 110) return 'prompt prompt--medium'
  return 'prompt'
}

function optionCard(option: Question['options'][number], config: QuestionFaceOptions): HTMLElement {
  const chosen = config.selected === option.id

  if (!config.interactive) {
    return h(
      'div',
      { class: 'option option--static', role: 'listitem' },
      h('span', { class: 'option-text', text: option.text }),
    )
  }

  return h(
    'button',
    {
      class: chosen ? 'option option--chosen' : 'option',
      type: 'button',
      role: 'radio',
      'aria-checked': String(chosen),
      disabled: config.disabled,
      on: { click: () => config.onChoose?.(option.id) },
    },
    h('span', { class: 'option-mark', 'aria-hidden': 'true' }),
    h('span', { class: 'option-text', text: option.text }),
  )
}

function textBody(config: QuestionFaceOptions): HTMLElement {
  if (!config.interactive) {
    return h('div', { class: 'text-answer text-answer--static' }, h('span', {
      class: 'muted',
      text: 'Everyone types their answer',
    }))
  }

  const input = h('textarea', {
    class: 'field text-answer',
    rows: '3',
    maxlength: String(MAX_TEXT_ANSWER_LEN),
    placeholder: 'Type your answer',
    'aria-label': 'Your answer',
    disabled: config.disabled,
  }) as HTMLTextAreaElement
  input.value = config.textValue ?? ''

  // The limit is high enough to hold a few paragraphs, so the field grows to
  // hold them too rather than making someone write into a three-line window.
  const field = grownField(input, MAX_TEXT_ANSWER_LEN)

  const submit = h(
    'button',
    {
      class: 'btn btn--primary btn--block',
      type: 'button',
      disabled: config.disabled,
      on: {
        click: () => {
          const value = input.value.trim()
          if (value) config.onText?.(value)
        },
      },
    },
    (config.answered ?? Boolean(config.textValue)) ? 'Update answer' : 'Send answer',
  )

  input.addEventListener('keydown', (event) => {
    // Enter used to send, on the assumption that an answer was a phrase. Now
    // that it can be several paragraphs, Enter has to be a newline: a phone
    // keyboard has no Shift to hold, so Enter-to-send made a second paragraph
    // impossible to type on the device most people answer from. Cmd/Ctrl+Enter
    // keeps the keyboard-only path to Send.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit.click()
    }
  })

  return h('div', { class: 'stack stack--tight' }, field, submit)
}

import { h } from '../dom'
import type { Question } from '../../shared/poll'

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
    h('h1', { class: 'prompt', text: question.prompt }),
    body,
  )
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
    maxlength: '140',
    placeholder: 'Type your answer',
    'aria-label': 'Your answer',
    disabled: config.disabled,
  }) as HTMLTextAreaElement
  input.value = config.textValue ?? ''

  const count = h('span', { class: 'char-count', text: `${input.value.length}/140` })

  input.addEventListener('input', () => {
    count.textContent = `${input.value.length}/140`
  })

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
    config.textValue ? 'Update answer' : 'Send answer',
  )

  input.addEventListener('keydown', (event) => {
    // Enter sends; Shift+Enter is a newline, which people expect in a textarea.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit.click()
    }
  })

  return h('div', { class: 'stack stack--tight' }, input, h('div', { class: 'row' }, h('span', { class: 'spacer' }), count), submit)
}

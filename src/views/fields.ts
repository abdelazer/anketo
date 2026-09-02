import { h, setText } from '../dom'

/**
 * Field behavior shared by Create and Respond.
 *
 * Both halves of the app ask people to type something that might be longer
 * than one line, and both used to punish them for it: text scrolled sideways
 * out of a single-line input, and a `maxlength` stopped the keyboard dead with
 * no warning. These two helpers are the fix — a field that grows to fit what
 * is in it, and a counter that turns up before the limit does.
 */

const growing = new Set<HTMLTextAreaElement>()
let watchingWidth = false

function fit(el: HTMLTextAreaElement): void {
  // `scrollHeight` covers content and padding but not the border, and these
  // fields are `border-box` — without adding it back the last line clips.
  el.style.height = 'auto'
  const border = el.offsetHeight - el.clientHeight
  el.style.height = `${el.scrollHeight + border}px`
}

/**
 * Grow a textarea to fit its content: no scrollbar, no fixed row count, and
 * nothing scrolled out of view while it is still being written.
 *
 * The right height depends on the field's width, which is unknown until it is
 * in the document — hence the frame's wait — and changes again when the phone
 * rotates. The resize pass drops fields whose view has since been torn down,
 * so this needs no disposal of its own.
 */
export function autoGrow<T extends HTMLTextAreaElement>(el: T): T {
  // The class carries the styling this behavior needs — no resize handle, no
  // scrollbar — so a caller cannot ask for one without the other.
  el.classList.add('field--auto')
  el.addEventListener('input', () => fit(el))
  requestAnimationFrame(() => fit(el))
  growing.add(el)

  if (!watchingWidth) {
    watchingWidth = true
    window.addEventListener('resize', () => {
      for (const field of growing) {
        if (field.isConnected) fit(field)
        else growing.delete(field)
      }
    })
  }
  return el
}

/**
 * A counter for a field's remaining room.
 *
 * It stays out of the way until the limit is close enough to be worth knowing
 * about — a running character count is noise at twelve characters and the
 * whole story at nineteen hundred — so what it replaces is the old failure
 * mode of finding out about a cap by typing into a field that has stopped
 * listening.
 */
export function charCounter(field: HTMLInputElement | HTMLTextAreaElement, max: number): HTMLElement {
  // Roughly the last sixth of the field, with a floor so a short limit still
  // gets a warning long enough to read.
  const showFrom = max - Math.max(24, Math.round(max / 6))
  const count = h('span', { class: 'char-count' })

  const update = () => {
    const used = field.value.length
    count.hidden = used < showFrom
    count.className = used >= max ? 'char-count char-count--full' : 'char-count'
    setText(count, `${used}/${max}`)
  }

  field.addEventListener('input', update)
  update()
  return count
}

/**
 * A growing field with its counter underneath, as one block that can sit in a
 * row next to something else. The counter takes no space at all until it
 * appears, so an ordinary short prompt looks exactly as it did.
 */
export function grownField(field: HTMLTextAreaElement, max: number): HTMLElement {
  return h('div', { class: 'field-wrap' }, autoGrow(field), charCounter(field, max))
}

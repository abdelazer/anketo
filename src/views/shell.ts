import { h } from '../dom'

/** The wordmark, used as the home link in every mode's top bar. */
export function brand(): HTMLElement {
  return h(
    'a',
    { class: 'brand', href: '/', 'aria-label': 'Anketo home' },
    h('span', {
      html: `<svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="currentColor" opacity="0.12"/>
        <rect x="7" y="16" width="5" height="9" rx="1.5" fill="currentColor"/>
        <rect x="13.5" y="11" width="5" height="14" rx="1.5" fill="currentColor"/>
        <rect x="20" y="7" width="5" height="18" rx="1.5" fill="currentColor"/>
      </svg>`,
      style: { color: 'var(--primary)', display: 'flex' },
    }),
    h('span', { text: 'Anketo' }),
  )
}

export function spinner(label = 'Loading'): HTMLElement {
  return h(
    'div',
    { class: 'screen screen--center' },
    h('div', { class: 'pulse', 'aria-hidden': 'true' }),
    h('p', { class: 'muted', text: label }),
  )
}

export function errorScreen(message: string, action?: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'screen screen--center' },
    h('h1', { class: 'display-sm', text: 'Nothing here' }),
    h('p', { class: 'muted', text: message }),
    action,
  )
}

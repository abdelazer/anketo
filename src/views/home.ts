import { api } from '../api'
import { h, toast } from '../dom'
import { navigate } from '../router'
import { brand } from './shell'

export function mountHome(root: HTMLElement): () => void {
  const button = h(
    'button',
    {
      class: 'btn btn--primary btn--big',
      on: {
        click: async () => {
          button.disabled = true
          button.textContent = 'Creating…'
          try {
            const { id } = await api.create()
            navigate(`/p/${id}/create`)
          } catch (error) {
            toast((error as Error).message, 'error')
            button.disabled = false
            button.textContent = 'Create a poll'
          }
        },
      },
    },
    'Create a poll',
  )

  root.appendChild(
    h(
      'div',
      { class: 'screen' },
      h('div', { class: 'topbar' }, brand()),
      h(
        'div',
        { class: 'grow stack home-hero' },
        h('h1', { class: 'display', text: 'Snap polls without fuss' }),
        h('p', {
          class: 'lede secondary-text',
          text: 'Write a few questions, put a QR code on the screen, and watch the answers land. No accounts, no apps.',
        }),
        button,
        h(
          'ol',
          { class: 'steps' },
          h('li', {}, h('strong', { text: 'Create' }), ' your questions and set a timer.'),
          h('li', {}, h('strong', { text: 'Lead' }), ' the poll from the shared screen.'),
          h('li', {}, h('strong', { text: 'Respond' }), ' — everyone scans and answers on their phone.'),
        ),
      ),
    ),
  )

  return () => {}
}

export function mountMissing(root: HTMLElement): () => void {
  root.appendChild(
    h(
      'div',
      { class: 'screen screen--center' },
      h('h1', { class: 'display-sm', text: 'No poll here' }),
      h('p', { class: 'muted', text: 'That link does not point at a poll.' }),
      h('a', { class: 'btn btn--primary', href: '/', text: 'Start a new one' }),
    ),
  )
  return () => {}
}

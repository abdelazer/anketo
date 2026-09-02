import './styles.css'
import { parse } from './router'
import { mountHome, mountMissing } from './views/home'
import { mountCreate } from './views/create'
import { mountLead } from './views/lead'
import { mountRespond } from './views/respond'

const root = document.getElementById('app')!
let unmount: (() => void) | null = null

function render(): void {
  unmount?.()
  unmount = null
  root.replaceChildren()

  const route = parse(location.pathname)
  switch (route.name) {
    case 'home':
      unmount = mountHome(root)
      break
    case 'create':
      unmount = mountCreate(root, route.pollId!)
      break
    case 'lead':
      unmount = mountLead(root, route.pollId!)
      break
    case 'respond':
      unmount = mountRespond(root, route.pollId!)
      break
    default:
      unmount = mountMissing(root)
  }
}

window.addEventListener('popstate', render)
render()

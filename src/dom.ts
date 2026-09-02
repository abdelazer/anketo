/** Minimal DOM helpers — enough structure to keep views readable, no framework. */

type Child = Node | string | number | null | undefined | false | Child[]

interface Props {
  class?: string
  text?: string
  html?: string
  hidden?: boolean
  disabled?: boolean
  value?: string
  style?: Partial<CSSStyleDeclaration>
  dataset?: Record<string, string>
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>
  [attr: string]: unknown
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue

    if (key === 'class') el.className = String(value)
    else if (key === 'text') el.textContent = String(value)
    else if (key === 'html') el.innerHTML = String(value)
    else if (key === 'style') Object.assign(el.style, value)
    else if (key === 'dataset') Object.assign(el.dataset, value)
    else if (key === 'on') {
      for (const [event, handler] of Object.entries(value as Record<string, EventListener>)) {
        el.addEventListener(event, handler)
      }
    } else if (key === 'value') (el as HTMLInputElement).value = String(value)
    else if (key in el && typeof value === 'boolean') (el as never as Record<string, unknown>)[key] = value
    else el.setAttribute(key, String(value))
  }

  append(el, children)
  return el
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    if (Array.isArray(child)) append(parent, child)
    else parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)))
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function replace(node: Element, ...children: Child[]): void {
  clear(node)
  append(node, children)
}

/** Set textContent only when it actually changed — cheap, and never disturbs selection. */
export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

export function svg(tag: string, attrs: Record<string, string | number> = {}, ...children: Node[]): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value))
  for (const child of children) el.appendChild(child)
  return el
}

let toastTimer: number | undefined

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = message
  el.className = kind === 'error' ? 'toast toast--error' : 'toast'
  el.hidden = false
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    el.hidden = true
  }, kind === 'error' ? 4200 : 2400)
}

/**
 * Share a URL through the native sheet, falling back to the clipboard.
 * Desktop browsers mostly lack `navigator.share`, and Safari throws
 * NotAllowedError if the gesture has gone stale — both land on the copy path.
 */
export async function shareLink(url: string, title: string): Promise<void> {
  if (navigator.share) {
    try {
      await navigator.share({ title, url })
      return
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return // User dismissed the sheet.
    }
  }
  try {
    await navigator.clipboard.writeText(url)
    toast('Link copied')
  } catch {
    window.prompt('Copy this link', url)
  }
}

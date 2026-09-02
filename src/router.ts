export interface Route {
  name: 'home' | 'create' | 'lead' | 'respond' | 'missing'
  pollId?: string
}

const MODE_PATH = /^\/p\/([a-z0-9]{4,16})\/(create|lead|respond)\/?$/

export function parse(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { name: 'home' }

  const match = MODE_PATH.exec(pathname)
  if (match) return { name: match[2] as Route['name'], pollId: match[1] }

  // A bare poll URL is a reasonable thing to type or paste; send it to Respond,
  // which is the mode a stranger with the link almost always wants.
  const bare = /^\/p\/([a-z0-9]{4,16})\/?$/.exec(pathname)
  if (bare) return { name: 'respond', pollId: bare[1] }

  return { name: 'missing' }
}

export function pollUrl(pollId: string, mode: 'create' | 'lead' | 'respond'): string {
  return `${location.origin}/p/${pollId}/${mode}`
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace) history.replaceState(null, '', path)
  else history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

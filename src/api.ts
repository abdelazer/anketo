import type { Snapshot } from '../shared/poll'

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  })

  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    /* A proxy or offline page can return non-JSON; fall through to the status. */
  }

  if (!response.ok) {
    const message = (body as { error?: string })?.error ?? `Request failed (${response.status})`
    throw new ApiError(response.status, message)
  }
  return body as T
}

export type View = 'lead' | 'respond' | 'create'

export const api = {
  create: () => request<{ id: string }>('/api/poll', { method: 'POST' }),

  snapshot: (id: string, view: View, device?: string) => {
    const params = new URLSearchParams({ id, view })
    if (device) params.set('device', device)
    return request<Snapshot>(`/api/poll?${params}`)
  },

  save: (id: string, rev: number, poll: unknown) =>
    request<Snapshot>('/api/poll', {
      method: 'PUT',
      body: JSON.stringify({ id, rev, poll }),
    }),

  act: (id: string, action: 'start' | 'next' | 'complete' | 'reset', index?: number) =>
    request<Snapshot>('/api/action', {
      method: 'POST',
      body: JSON.stringify({ id, action, index }),
    }),

  answer: (id: string, questionId: string, deviceId: string, value: string) =>
    request<Snapshot>('/api/answer', {
      method: 'POST',
      body: JSON.stringify({ id, questionId, deviceId, value }),
    }),
}

/** GET a snapshot, POST a new poll, PUT edits from Create mode. */
import {
  HttpError,
  createPoll,
  json,
  loadPoll,
  loadSnapshot,
  sanitizeDraft,
  updatePoll,
  type View,
} from '../../shared/server'

const asView = (value: string | null): View =>
  value === 'lead' || value === 'create' ? value : 'respond'

export default async (req: Request): Promise<Response> => {
  try {
    const url = new URL(req.url)

    if (req.method === 'POST') {
      const poll = await createPoll()
      return json({ id: poll.id }, 201)
    }

    if (req.method === 'GET') {
      const id = url.searchParams.get('id')
      if (!id) throw new HttpError(400, 'Missing poll id.')
      const poll = await loadPoll(id)
      return json(
        await loadSnapshot(poll, {
          view: asView(url.searchParams.get('view')),
          deviceId: url.searchParams.get('device') ?? undefined,
        }),
      )
    }

    if (req.method === 'PUT') {
      const body = (await req.json()) as { id?: string; rev?: number; poll?: unknown }
      if (!body.id) throw new HttpError(400, 'Missing poll id.')

      const saved = await updatePoll(body.id, (current) => {
        // Reordering or deleting questions mid-run would orphan recorded
        // answers, so the editor is read-only from Start Poll onward.
        if (current.phase !== 'draft') {
          throw new HttpError(409, 'Reset the poll before editing its questions.')
        }
        // Stale editor — usually the same poll open on a second device.
        if (typeof body.rev === 'number' && body.rev !== current.rev) {
          throw new HttpError(409, 'This poll was edited somewhere else.')
        }
        return sanitizeDraft(body.poll, current)
      })

      return json(await loadSnapshot(saved, { view: 'create' }))
    }

    return json({ error: 'Method not allowed.' }, 405)
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status)
    console.error('poll function failed', error)
    return json({ error: 'Something went wrong.' }, 500)
  }
}

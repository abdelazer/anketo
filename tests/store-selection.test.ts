/**
 * Which Blobs store an environment gets is a safety property, not a preference:
 * the global store holds live polls, and a preview deploy reaching it means a
 * preview's Start button drives someone's real room.
 *
 * It cannot be covered by the API suite, because `netlify dev` force-sets
 * `CONTEXT=dev` and `NETLIFY_DEV=true` on every function invocation and offers
 * no way to impersonate a deployed context. So the decision is asserted
 * directly, and the case that matters most is the last one: an environment
 * carrying none of these markers must be treated as untrusted, not as
 * production.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { usesGlobalStore } from '../shared/server'

const MARKERS = ['CONTEXT', 'NETLIFY_DEV', 'NETLIFY_LOCAL'] as const

const original = Object.fromEntries(MARKERS.map((k) => [k, process.env[k]]))

/** Start from an environment that sets none of the markers, then add some back. */
function withEnv(overrides: Partial<Record<(typeof MARKERS)[number], string>>): boolean {
  for (const key of MARKERS) delete process.env[key]
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value
  return usesGlobalStore()
}

afterEach(() => {
  for (const key of MARKERS) {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('global store access', () => {
  it('is granted to production', () => {
    expect(withEnv({ CONTEXT: 'production' })).toBe(true)
  })

  it('is granted to local dev, which netlify dev marks two ways', () => {
    expect(withEnv({ NETLIFY_DEV: 'true' })).toBe(true)
    expect(withEnv({ NETLIFY_LOCAL: 'true' })).toBe(true)
    expect(withEnv({ CONTEXT: 'dev', NETLIFY_DEV: 'true', NETLIFY_LOCAL: 'true' })).toBe(true)
  })

  it('is refused to preview and branch deploys', () => {
    expect(withEnv({ CONTEXT: 'deploy-preview' })).toBe(false)
    expect(withEnv({ CONTEXT: 'branch-deploy' })).toBe(false)
  })

  it('is refused to a context nobody anticipated', () => {
    expect(withEnv({ CONTEXT: 'some-future-context' })).toBe(false)
  })

  // The regression this file exists for. An allowlist of preview contexts would
  // pass every case above and still fail this one — by handing a runtime that
  // reports nothing about itself the store full of live polls.
  it('is refused when the runtime carries no markers at all', () => {
    expect(withEnv({})).toBe(false)
  })

  it('is not fooled by a falsy marker value', () => {
    expect(withEnv({ NETLIFY_DEV: 'false', NETLIFY_LOCAL: 'false' })).toBe(false)
    expect(withEnv({ CONTEXT: '' })).toBe(false)
  })
})

/**
 * Boots `netlify dev` for the API suite, unless one is already listening.
 *
 * The tests run against the real Functions runtime and the real Blobs store on
 * purpose. Mocking the store is what let the original compare-and-swap bug
 * through: the ETag it depended on is absent in some runtimes, and only a real
 * store reproduces that.
 */
import { spawn, type ChildProcess } from 'node:child_process'

export const BASE_URL = process.env.ANKETO_BASE_URL ?? 'http://localhost:8888'

let child: ChildProcess | undefined

async function reachable(): Promise<boolean> {
  try {
    // Any routed API response proves the redirect and the functions are live.
    const response = await fetch(`${BASE_URL}/api/poll?id=zzzzzzz&view=lead`)
    return response.status === 404 || response.ok
  } catch {
    return false
  }
}

async function waitUntilReachable(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await reachable()) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`netlify dev did not become reachable at ${BASE_URL} in time`)
}

export async function setup(): Promise<void> {
  if (await reachable()) {
    console.log(`[tests] reusing the dev server already listening at ${BASE_URL}`)
    return
  }
  if (process.env.ANKETO_BASE_URL) {
    throw new Error(`ANKETO_BASE_URL is set to ${BASE_URL} but nothing is listening there`)
  }

  console.log('[tests] starting netlify dev…')
  child = spawn('netlify', ['dev', '--port', '8888'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  child.on('error', (error) => console.error('[tests] netlify dev failed to spawn', error))

  await waitUntilReachable(150_000)
  console.log('[tests] netlify dev ready')
}

export async function teardown(): Promise<void> {
  // Kill the whole process group — netlify dev spawns Vite and Deno children.
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

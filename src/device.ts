/**
 * Per-browser identity and the seeded shuffle.
 *
 * The device id is what makes "one answer, changeable until the timer ends"
 * possible without accounts. The shuffle is seeded from it so a respondent's
 * options keep the same order across re-renders and refreshes — reshuffling
 * under someone's thumb mid-tap would be worse than not shuffling at all.
 */

const DEVICE_KEY = 'anketo:device'

export function deviceId(): string {
  let id = safeGet(DEVICE_KEY)
  if (!id) {
    id = crypto.randomUUID()
    safeSet(DEVICE_KEY, id)
  }
  return id
}

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null // Private mode, or storage blocked entirely.
  }
}

export function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* Nothing here is load-bearing; the server is the source of truth. */
  }
}

export function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

function hash32(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates with a seed derived from the inputs — same seed, same order. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const random = mulberry32(hash32(seed))
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

import { api, ApiError, type View } from './api'
import { safeGet, safeSet } from './device'
import { revealAt, type Snapshot } from '../shared/poll'

/**
 * The polling ladder from the spec. Backing off matters: a 30-person room
 * sitting on a results screen would otherwise burn a function invocation per
 * device per second for as long as the Leader keeps talking.
 *
 * It resets to the start whenever anything actually happened, so the moment a
 * poll goes live it is back to checking every second.
 */
const LADDER = [1, 1, 2, 3, 5, 8, 13]

/** Redraw rate for countdown digits — smooth enough, far cheaper than rAF. */
const TICK_MS = 200

type Listener = (snapshot: Snapshot) => void

export class PollStore {
  snapshot: Snapshot | null = null
  error: string | null = null
  /** False until the first successful fetch; cached state may be seconds stale. */
  live = false
  offline = false

  private listeners = new Set<Listener>()
  private tickers = new Set<() => void>()
  private step = 0
  private timer: number | undefined
  private ticker: number | undefined
  private inFlight = false
  private stopped = true
  private fingerprint = ''

  constructor(
    readonly pollId: string,
    readonly view: View,
    private readonly deviceId?: string,
  ) {}

  // --- Clock ---------------------------------------------------------------

  /**
   * Server time as this device best understands it. Every countdown is
   * computed from this rather than `Date.now()`, so a phone with a skewed
   * clock still sees the same timer as the projected laptop.
   */
  serverNow(): number {
    return Date.now() + this.offsetMs
  }

  private offsetMs = 0

  // --- Subscriptions -------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Fires ~5×/second while mounted, for countdown rendering only. */
  onTick(fn: () => void): () => void {
    this.tickers.add(fn)
    return () => this.tickers.delete(fn)
  }

  private emit(): void {
    if (this.snapshot) for (const listener of this.listeners) listener(this.snapshot)
  }

  // --- Lifecycle -----------------------------------------------------------

  start(): void {
    if (!this.stopped) return
    this.stopped = false

    const cached = this.readCache()
    if (cached && !this.snapshot) {
      this.snapshot = cached
      this.emit()
    }

    this.ticker = window.setInterval(() => {
      for (const fn of this.tickers) fn()
    }, TICK_MS)

    document.addEventListener('visibilitychange', this.onVisibility)
    window.addEventListener('online', this.onOnline)

    void this.refresh()
  }

  stop(): void {
    this.stopped = true
    window.clearTimeout(this.timer)
    window.clearInterval(this.ticker)
    document.removeEventListener('visibilitychange', this.onVisibility)
    window.removeEventListener('online', this.onOnline)
    this.listeners.clear()
    this.tickers.clear()
  }

  private onVisibility = (): void => {
    // A backgrounded tab is a phone in a pocket; resume with a fresh read so
    // the Leader's screen is never stale the instant they look at it again.
    if (document.hidden) window.clearTimeout(this.timer)
    else {
      this.step = 0
      void this.refresh()
    }
  }

  private onOnline = (): void => {
    this.step = 0
    void this.refresh()
  }

  // --- Polling -------------------------------------------------------------

  /** Adopt a snapshot returned by a write, so an action's effect shows instantly. */
  apply(snapshot: Snapshot): void {
    this.absorb(snapshot)
    this.step = 0
    this.emit()
    this.schedule()
  }

  /** Something happened locally — go back to checking every second. */
  quicken(): void {
    this.step = 0
    this.schedule()
  }

  async refresh(): Promise<void> {
    if (this.inFlight || this.stopped) return
    this.inFlight = true
    try {
      const snapshot = await api.snapshot(this.pollId, this.view, this.deviceId)
      const changed = this.absorb(snapshot)
      this.offline = false
      this.error = null
      // Idle rooms back off; any change at all snaps the cadence back to 1s.
      this.step = changed ? 0 : Math.min(this.step + 1, LADDER.length - 1)
      this.emit()
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        this.error = error.message
        this.emit()
        this.inFlight = false
        return // Nothing to poll for; a missing poll will not appear later.
      }
      this.offline = true
      this.step = Math.min(this.step + 1, LADDER.length - 1)
      this.emit()
    } finally {
      this.inFlight = false
    }
    this.schedule()
  }

  private absorb(snapshot: Snapshot): boolean {
    // Latency skews this by roughly half a round trip, which is far below the
    // one-second resolution any countdown is displayed at.
    this.offsetMs = snapshot.serverTime - Date.now()
    this.live = true

    const next = this.fingerprintOf(snapshot)
    const changed = next !== this.fingerprint
    this.fingerprint = next
    this.snapshot = snapshot
    this.writeCache(snapshot)
    return changed
  }

  /** What "something happened" means for the ladder: state, or new answers. */
  private fingerprintOf(snapshot: Snapshot): string {
    return JSON.stringify([
      snapshot.poll.rev,
      snapshot.poll.phase,
      snapshot.poll.currentIndex,
      snapshot.responseCounts,
      Object.keys(snapshot.tallies),
    ])
  }

  private schedule(): void {
    if (this.stopped || document.hidden) return
    window.clearTimeout(this.timer)

    const delay = LADDER[Math.min(this.step, LADDER.length - 1)] * 1000
    let at = Date.now() + delay

    // If a countdown expires before the next scheduled poll, land on it
    // instead: results should appear when the timer hits zero, not up to 13
    // seconds later.
    const reveal = this.nextRevealAt()
    if (reveal !== null && reveal > Date.now() && reveal + 200 < at) at = reveal + 200

    this.timer = window.setTimeout(() => void this.refresh(), Math.max(250, at - Date.now()))
  }

  /** Local-clock time at which the current question's answers unlock. */
  private nextRevealAt(): number | null {
    const snapshot = this.snapshot
    if (!snapshot || snapshot.poll.phase !== 'active') return null
    const question = snapshot.poll.questions[snapshot.poll.currentIndex]
    if (!question) return null
    const at = revealAt(snapshot.poll, question.id)
    return at === null ? null : at - this.offsetMs
  }

  // --- Optimistic cache ----------------------------------------------------

  private get cacheKey(): string {
    return `anketo:snap:${this.pollId}:${this.view}`
  }

  private readCache(): Snapshot | null {
    const raw = safeGet(this.cacheKey)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Snapshot
      return parsed?.poll?.id === this.pollId ? parsed : null
    } catch {
      return null
    }
  }

  private writeCache(snapshot: Snapshot): void {
    safeSet(this.cacheKey, JSON.stringify(snapshot))
  }
}

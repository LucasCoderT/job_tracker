/**
 * useLiveRefresh — a page keeps itself current while it is waiting on the Mac.
 *
 * Everything the site hands to an agent is a wait: an apply pack is a median of
 * 41 minutes, an interview pack longer, drafted answers ride the apply worker's
 * tick, an evaluation lands whenever the eval worker reaches it. The site
 * already pushes a notification when that work finishes, and `useRealtime`
 * already carries the event — but no component subscribed to it, so the only
 * way to see the result was to reload the page. The notification told him it
 * was ready and then made him go and fetch it by hand.
 *
 * This is the consumer side, and it is two mechanisms on purpose:
 *
 * - **The socket is the fast path.** A matching pipeline event refreshes in
 *   about a second, which is what makes tabbing back feel instantaneous.
 * - **Polling is the honest path.** The socket can be closed, asleep, or
 *   silently half-dead behind a phone's NAT, and `announce` is best-effort by
 *   design — a route that failed to broadcast still wrote its state. Polling
 *   means "eventually correct" never depends on a courtesy.
 *
 * THE RULE THAT KEEPS THIS CHEAP: **poll only while something is actually
 * waiting, and only while the tab is visible.** Listings cost one KV read
 * because of the index, but a page left open all night at a fixed interval is
 * how the 2026-09-16 quota outage happened in the first place — machines
 * outnumbering people. A page with nothing pending does not poll at all, and a
 * hidden tab does not poll at all; it refreshes once on becoming visible, which
 * is exactly the moment he is looking at it.
 */
import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { useRealtime, type PipelineEvent, type PipelineEventName } from './useRealtime'

/** The two statuses that mean "an agent has this and has not finished". */
export function isWaitingStatus(s?: string | null): boolean {
  return s === 'requested' || s === 'building'
}

/** True when this posting has anything outstanding with the Mac. */
export function postingIsWaiting(p: {
  pack?: string
  answerStatus?: string
  parseStatus?: string
}): boolean {
  return isWaitingStatus(p.pack) || isWaitingStatus(p.answerStatus) || isWaitingStatus(p.parseStatus)
}

export interface LiveRefreshOptions {
  /** Re-fetch this page's data. Usually a `useFetch` refresh. */
  refresh: () => unknown | Promise<unknown>
  /** Is anything on this page still with an agent? Polling follows this. */
  waiting: () => boolean
  /** Refresh only on these events. Omit to refresh on any pipeline event. */
  events?: readonly PipelineEventName[]
  /** Detail pages: ignore events about other records. */
  id?: () => string | undefined
  /** Cadence while waiting with no live socket. */
  pollMs?: number
  /** Cadence while waiting *and* connected — a backstop for a half-dead socket. */
  socketPollMs?: number
  /**
   * Stop the background timer after this long in one continuous wait. The
   * socket and the refresh-on-focus both keep working; only the ticking stops.
   *
   * Some waits never end. A posting below the eval worker's score gate is never
   * picked up at all, so "waiting to be evaluated" is a true statement about a
   * page that would otherwise poll until the tab was closed — a laptop left
   * open overnight on one brief, quietly spending the read budget the listing
   * index was built to protect. Half an hour covers every wait that actually
   * resolves (a pack is a median of 41 minutes, but it announces), and the
   * moment he looks at the tab again it fetches regardless.
   */
  maxPollMs?: number
}

export function useLiveRefresh(options: LiveRefreshOptions): {
  status: Ref<'idle' | 'connecting' | 'open' | 'closed'>
  refreshing: Ref<boolean>
  lastSyncedAt: Ref<string | null>
} {
  const { refresh, waiting } = options
  const pollMs = options.pollMs ?? 15_000
  const socketPollMs = options.socketPollMs ?? 60_000
  const maxPollMs = options.maxPollMs ?? 30 * 60_000

  const refreshing = ref(false)
  const lastSyncedAt = ref<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | null = null
  /** When the current uninterrupted wait began, for the maxPollMs cap. */
  let waitingSince: number | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

  async function run() {
    // One at a time. Several events often land together (a status write plus
    // the meta push behind it) and three overlapping refreshes of the same
    // listing would race to set the same ref.
    if (refreshing.value || disposed) return
    refreshing.value = true
    try {
      await refresh()
      lastSyncedAt.value = new Date().toISOString()
    } catch {
      /* a failed refresh is the old data, not an error state — the next tick retries */
    } finally {
      refreshing.value = false
    }
  }

  /** Coalesce a burst of events into one fetch. */
  function soon() {
    if (debounce) return
    debounce = setTimeout(() => { debounce = null; void run() }, 300)
  }

  const { status } = useRealtime((evt: PipelineEvent) => {
    if (options.events && !options.events.includes(evt.event)) return
    const want = options.id?.()
    // An event with no id is a broadcast about the pipeline as a whole, so a
    // detail page still takes it; one carrying a different id is not ours.
    if (want && evt.id && evt.id !== want) return
    soon()
  })

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null }
    if (disposed || !visible()) return
    if (!waiting()) { waitingSince = null; return }   // settled: the timer stops here
    if (waitingSince === null) waitingSince = Date.now()
    if (Date.now() - waitingSince >= maxPollMs) return // give up ticking; focus and the socket still work
    const every = status.value === 'open' ? socketPollMs : pollMs
    timer = setTimeout(async () => { await run(); schedule() }, every)
  }

  // Start, stop and re-pace the timer as the page's own state changes: work
  // finishing is what stops the polling, and that is the whole cost control.
  watch([() => waiting(), status], schedule, { immediate: true })

  function onVisibility() {
    if (!visible()) { if (timer) { clearTimeout(timer); timer = null } ; return }
    // The moment he tabs back is the moment the answer matters. Fetch now
    // rather than waiting out whatever remained of the interval.
    if (waiting()) { waitingSince = Date.now(); void run() }
    schedule()
  }

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)

  onScopeDispose(() => {
    disposed = true
    if (timer) clearTimeout(timer)
    if (debounce) clearTimeout(debounce)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  })

  return { status, refreshing, lastSyncedAt }
}

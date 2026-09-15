import { ref, onBeforeUnmount } from 'vue'
import type { Job, JobStatusResult, JobStatusSnapshot, Stats } from '../../shared/types'

/**
 * Marking an application rejected or moved on a round, from the tracker.
 *
 * The awkward part is not the write, it is the two caches in front of the
 * read: /api/stats is edge-cached for five minutes *and* sent with
 * `max-age=300`, so an ordinary refetch after a change hands back the old
 * payload and the card slides straight back to where it was. So:
 *
 *  1. the route answers with the row rebuilt from Notion's own PATCH response,
 *     and the card is moved from that — at once, no refetch;
 *  2. the route purges the edge copy, so the next load reads Notion;
 *  3. a moment later the page makes one `?fresh=1` read (no cache either way)
 *     to bring the counts — conversion strip, stat cards, column badges — in
 *     line with the move.
 *
 * Rows changed in the last two minutes keep what the PATCH returned even if
 * that fresh read disagrees: Notion's query can trail its own write by a
 * moment, and a card should not jump back to a column he just moved it out of.
 */
const RECENT_MS = 120_000
const bare = (id: string) => id.replace(/-/g, '').toLowerCase()

export interface StatusToast {
  text: string
  error: boolean
  undo: (() => void) | null
}

export function useJobStatus() {
  // Nuxt 4's useFetch data is a shallow ref: a job edited in place re-renders
  // nothing. Every change below replaces `stats.value` whole.
  const { data: stats } = useNuxtData<Stats>('stats')

  const busyId = ref<string | null>(null)
  const toast = ref<StatusToast | null>(null)
  const recent = new Map<string, { job: Job; at: number }>()

  let toastTimer: ReturnType<typeof setTimeout> | undefined
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined
  onBeforeUnmount(() => {
    clearTimeout(toastTimer)
    clearTimeout(reconcileTimer)
  })

  function say(next: StatusToast) {
    clearTimeout(toastTimer)
    toast.value = next
    // Long enough to reach for Undo on a phone; an error stays until closed.
    if (!next.error) toastTimer = setTimeout(() => (toast.value = null), 9000)
  }

  function place(job: Job) {
    recent.set(bare(job.id), { job, at: Date.now() })
    const s = stats.value
    if (!s) return
    stats.value = { ...s, jobs: s.jobs.map((j) => (bare(j.id) === bare(job.id) ? job : j)) }
  }

  function reconcile() {
    clearTimeout(reconcileTimer)
    reconcileTimer = setTimeout(async () => {
      try {
        const fresh = await $fetch<Stats>('/api/stats', { query: { fresh: '1' } })
        const cutoff = Date.now() - RECENT_MS
        stats.value = {
          ...fresh,
          jobs: fresh.jobs.map((j) => {
            const r = recent.get(bare(j.id))
            return r && r.at > cutoff ? r.job : j
          }),
        }
      } catch {
        // The card already moved. Counts catch up on the next load, which the
        // purge guarantees reads Notion.
      }
    }, 1500)
  }

  const describe = (s: JobStatusSnapshot) =>
    s.status === 'Rejected' ? 'rejected' : s.stage ? `${s.status ?? 'no status'} · ${s.stage}` : (s.status ?? 'no status')

  async function send(job: Job, body: Record<string, unknown>, done: (r: JobStatusResult) => StatusToast) {
    if (busyId.value) return
    busyId.value = job.id
    try {
      const res = await $fetch<JobStatusResult>(`/api/jobs/${bare(job.id)}/status`, { method: 'POST', body })
      place(res.job)
      say(done(res))
      reconcile()
    } catch (err: any) {
      say({ text: `${job.company}: ${err?.data?.statusMessage || err?.message || 'could not update Notion'}`, error: true, undo: null })
    } finally {
      busyId.value = null
    }
  }

  function undoFor(res: JobStatusResult) {
    return () =>
      send(res.job, { action: 'restore', previous: res.previous }, () => ({
        text: `Undone — ${res.job.company} is back to ${describe(res.previous)}.`,
        error: false,
        undo: null,
      }))
  }

  const reject = (job: Job) =>
    send(job, { action: 'reject' }, (res) => ({
      text: `${job.company} marked rejected.`,
      error: false,
      undo: undoFor(res),
    }))

  const advance = (job: Job, stage: string) =>
    send(job, { action: 'advance', stage }, (res) => ({
      text: stage === 'Offer' ? `${job.company}: offer.` : `${job.company} moved on to ${stage}.`,
      error: false,
      undo: undoFor(res),
    }))

  return { busyId, toast, reject, advance, dismiss: () => (toast.value = null) }
}

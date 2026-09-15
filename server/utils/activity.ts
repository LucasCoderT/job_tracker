/**
 * Status changes he makes from the tracker, kept so the EI day can see them.
 *
 * Notion has no history of a row, and last_edited_time cannot stand in: the
 * Mac's email classifier edits the same rows, and its work is not his
 * job-search time. So the one route he drives — POST /api/jobs/:id/status —
 * writes a small event here, and Undo takes it back out.
 *
 *   activity:<YYYY-MM-DD local>  →  { events: ActivityEvent[] }
 *
 * **One document per day, read by exact key — never `list()`.** The first
 * version wrote one key per event and found them with a prefix listing, and
 * KV listings trail writes by up to a minute. Both halves failed in
 * production: the EI day read a second after a rejection did not see it, and
 * Undo, which also listed, could not find the event it was meant to delete —
 * so an undone rejection stayed in the record. A get by key sees its own
 * write at once in the colo that made it, which is the colo he is on.
 *
 * Two changes landing in the same instant could race on the document; the
 * tracker allows one change at a time, so they do not.
 *
 * Lives in the POSTINGS namespace under its own prefix; every other scan of
 * that namespace lists `meta:` only. A day expires 180 days after its last
 * change — the EI log is the durable record, these only propose rows for it.
 */
import type { ActivityEvent } from '../../shared/types'
import type { KVNamespace } from './notion'
import { localDate } from './ei-week'

const TTL_SECONDS = 180 * 86_400
const bare = (id: string) => id.replace(/-/g, '').toLowerCase()
const keyFor = (day: string) => `activity:${day}`

async function readDay(kv: KVNamespace, day: string): Promise<ActivityEvent[]> {
  const doc = (await kv.get(keyFor(day), 'json')) as { events?: ActivityEvent[] } | null
  return Array.isArray(doc?.events) ? doc!.events : []
}

async function writeDay(kv: KVNamespace, day: string, events: ActivityEvent[]): Promise<void> {
  if (!events.length) return kv.delete(keyFor(day))
  await kv.put(keyFor(day), JSON.stringify({ events }), { expirationTtl: TTL_SECONDS })
}

export async function recordActivity(kv: KVNamespace, event: Omit<ActivityEvent, 'day' | 'at'>): Promise<void> {
  const at = new Date().toISOString()
  const day = localDate(at)!
  const events = await readDay(kv, day)
  events.push({ ...event, pageId: bare(event.pageId), at, day })
  await writeDay(kv, day, events)
}

/**
 * Undo: take back the newest event for this page from the last fifteen
 * minutes. Checks the local day at both ends of that window, so an undo
 * pressed just after midnight still finds a change made just before it.
 */
export async function cancelLatestActivity(kv: KVNamespace, pageId: string): Promise<boolean> {
  const id = bare(pageId)
  const since = new Date(Date.now() - 15 * 60_000).toISOString()
  const days = [...new Set([localDate(new Date().toISOString())!, localDate(since)!])]
  for (const day of days) {
    const events = await readDay(kv, day)
    let newest = -1
    events.forEach((e, i) => {
      if (e.pageId === id && e.at >= since && (newest < 0 || e.at > events[newest]!.at)) newest = i
    })
    if (newest >= 0) {
      events.splice(newest, 1)
      await writeDay(kv, day, events)
      return true
    }
  }
  return false
}

/** Every event in [monday, sunday]: seven reads by exact key. */
export async function listActivity(kv: KVNamespace, monday: string, sunday: string): Promise<ActivityEvent[]> {
  const days: string[] = []
  for (let d = new Date(`${monday}T12:00:00Z`); d.toISOString().slice(0, 10) <= sunday; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10))
  }
  const all = (await Promise.all(days.map((day) => readDay(kv, day)))).flat()
  return all.sort((a, b) => a.at.localeCompare(b.at))
}

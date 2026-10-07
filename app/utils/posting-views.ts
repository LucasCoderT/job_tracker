/**
 * The postings list's saved views and its sort, in one place.
 *
 * They lived inside pages/postings/index.vue until the brief got next/previous
 * (j and k): "the next posting" has to mean the next row of the list he was
 * just looking at, so the brief needs the same filter and the same order. Two
 * copies would drift the first time a view changed.
 */
import { postingChannel, localityOf, inNewQueue } from '#shared/postings'
import type { PostingMeta } from '../../shared/types'

export const VIEW_STORE_KEY = 'postings.view'
export const SORT_STORE_KEY = 'postings.sort'

/**
 * Saved views. The counts are the navigation: the number tells him whether a
 * view is worth opening before he opens it, which a row of plain tabs cannot.
 *
 * "Ready to send" is the one that earns its place — a pack built and not yet
 * sent is the only state on this page with something to do right now.
 */
export const POSTING_VIEWS: { key: string; label: string; dot: string; match: (p: PostingMeta) => boolean }[] = [
  { key: 'all', label: 'All', dot: 'var(--stone)', match: () => true },
  // Closed listings leave New rather than being deleted: the record is still
  // worth keeping (it was evaluated, it may be reposted), it just is not
  // something he can act on this morning.
  { key: 'new', label: 'New', dot: 'var(--amber)', match: (p) => inNewQueue(p) },
  // The morning scan publishes a quick score before the full evaluation, and
  // anything it scored under the worker's gate is only evaluated on request.
  // Those wait here rather than in New, which holds evaluated postings only.
  { key: 'unevaluated', label: 'Not evaluated', dot: 'var(--stone)', match: (p) => p.state === 'new' && !p.closedAt && !p.hasAnalysis },
  { key: 'ready', label: 'Ready to send', dot: 'var(--green)', match: (p) => p.pack === 'done' && p.state !== 'applied' },
  // Edmonton and Alberta, in-office or hybrid — not remote roles that merely
  // list an office here. The deepest process in the funnel has this shape and
  // the scoring has never valued it, so it gets a view of its own.
  { key: 'local', label: 'Local', dot: 'var(--teal)', match: (p) => ['edmonton', 'alberta'].includes(localityOf(p.location, p.geo)) },
  { key: 'evaluated', label: 'Evaluated', dot: 'var(--blue)', match: (p) => p.hasAnalysis },
  { key: 'applied', label: 'Applied', dot: 'var(--teal)', match: (p) => p.state === 'applied' },
  // A source that refuses to be read leaves no role and no score, so the row
  // sorts to the bottom of a hundred and fifty and is effectively lost. It
  // needs a door of its own: the only fix is him pasting the description.
  { key: 'needs', label: 'Needs details', dot: 'var(--amber)', match: (p) => !p.role && !p.hasJD && p.state === 'new' },
  { key: 'closed', label: 'Listing closed', dot: 'var(--stone)', match: (p) => Boolean(p.closedAt) },
  { key: 'dismissed', label: 'Dismissed', dot: 'var(--rust)', match: (p) => p.state === 'dismissed' },
]

const STATE_ORDER = ['new', 'applied', 'dismissed']

// ---- score and date filters (2026-10-07) ----
//
// "Everything at 4.0 or better from the last three days" is the list he wants
// to select whole and build packs for. Both narrow whatever view is open, and
// with search and source: every filter is ANDed.

const EDMONTON_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', year: 'numeric', month: '2-digit', day: '2-digit' })

/** A Date as YYYY-MM-DD in Edmonton, the same day boundary the EI log uses. */
export const edmontonDay = (d: Date): string => EDMONTON_DAY.format(d)

/**
 * The day a posting was added, as the Added column shows it. `firstSeen` is
 * date-only and already local; `createdAt` is a UTC instant and an evening
 * add would otherwise land on the next day.
 */
export function addedDay(p: PostingMeta): string {
  if (p.firstSeen && /^\d{4}-\d{2}-\d{2}$/.test(p.firstSeen)) return p.firstSeen
  const t = Date.parse(p.firstSeen || p.createdAt)
  return Number.isFinite(t) ? edmontonDay(new Date(t)) : ''
}

export const DATE_PRESETS: { value: string; label: string; days: number }[] = [
  { value: 'any', label: 'Any time', days: 0 },
  { value: '1', label: 'Today', days: 1 },
  { value: '3', label: 'Last 3 days', days: 3 },
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '14', label: 'Last 14 days', days: 14 },
  { value: 'custom', label: 'Custom range', days: 0 },
]

/** The inclusive day range a preset means today. "Last 3 days" is today and the two before it. */
export function presetRange(preset: string, now = new Date()): { from: string; to: string } {
  const days = DATE_PRESETS.find((d) => d.value === preset)?.days ?? 0
  if (!days) return { from: '', to: '' }
  return { from: edmontonDay(new Date(now.getTime() - (days - 1) * 86_400_000)), to: '' }
}

export interface PostingFilter {
  minScore: number | null
  from: string // YYYY-MM-DD inclusive, '' = open
  to: string
}

/**
 * A minimum score excludes unscored postings: "at least 4.0" is a claim an
 * unscored row cannot meet, and letting them through would put postings nobody
 * has read into a mass build.
 */
export function passesFilter(p: PostingMeta, f: PostingFilter): boolean {
  if (f.minScore != null && !((p.score ?? -1) >= f.minScore)) return false
  if (f.from || f.to) {
    const day = addedDay(p)
    if (!day) return false
    if (f.from && day < f.from) return false
    if (f.to && day > f.to) return false
  }
  return true
}

function sortValue(p: PostingMeta, key: string): string | number {
  switch (key) {
    case 'score': return p.score ?? -1
    case 'company': return p.company.toLowerCase()
    case 'comp': return p.comp || ''
    case 'geo': return p.geo || p.location || ''
    case 'source': return postingChannel(p.url)
    case 'state': return STATE_ORDER.indexOf(p.state)
    case 'age': return Date.parse(p.firstSeen || p.createdAt) || 0
    default: return 0
  }
}

/** The list's order. Newest first by default, with score breaking same-day ties. */
export function sortPostings(list: PostingMeta[], key: string, dir: number): PostingMeta[] {
  return [...list].sort((a, b) => {
    const x = sortValue(a, key)
    const y = sortValue(b, key)
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
    // Same-day ties are the common case when sorting by age, so fall back to
    // score rather than leaving the order arbitrary.
    if (cmp === 0 && key !== 'score') return (b.score ?? -1) - (a.score ?? -1)
    return cmp * dir
  })
}

/** The view and sort he last had open on the list. Client only; the defaults are the list's own. */
export function savedPostingQueue(): { view: string; sortKey: string; sortDir: number } {
  const out = { view: 'new', sortKey: 'age', sortDir: -1 }
  try {
    const view = localStorage.getItem(VIEW_STORE_KEY)
    if (view && POSTING_VIEWS.some((v) => v.key === view)) out.view = view
    const [k, d] = (localStorage.getItem(SORT_STORE_KEY) ?? '').split(':')
    if (k) out.sortKey = k
    if (d === '1' || d === '-1') out.sortDir = Number(d)
  } catch {
    /* private mode, blocked storage — the defaults are fine */
  }
  return out
}

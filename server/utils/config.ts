/**
 * Tunable constants + the status ladder. Ported verbatim from the original
 * Worker — the ladder order and the two-metric split are load-bearing (see
 * CLAUDE.md "The data model").
 */
import type { BucketKey } from '../../shared/types'

export const NOTION_VERSION = '2022-06-28'
export const CACHE_TTL_SECONDS = 300

// Bump whenever the /api/stats payload shape changes — it keys the edge cache,
// so a deploy never serves an old-shaped cached response to new frontend code.
// v6: added `roles` (reply rate by role type) and `salary` (salary context).
// v7: enriched `jobs` rows with salary/source/nextAction for the applications table.
export const SCHEMA_VERSION = '7'

export const DEFAULT_STALE_DAYS = 30
export const ATTENTION_MIN_DAYS = 10
export const MAX_SOURCES = 6

export const STATUS_PROP = 'Status'
export const DATE_PROP = 'Application Date'
export const POSITION_PROP = 'Position'
export const NEXT_ACTION_PROP = 'Next Action'
export const SOURCE_PROP = 'Reference Link'
export const SALARY_PROP = 'Salary' // number (annual); ~43% of rows populated
export const INTERVIEWED_PROP = 'Interviewed' // optional checkbox, absent today

// Notion Status option (case-insensitive) → funnel bucket.
export const STATUS_BUCKETS: Record<string, string> = {
  applied: 'applied',
  pending: 'pending',
  interviewed: 'interviewed',
  progressing: 'progressing',
  interviewing: 'interviewed',
  'offer accepted': 'offerAccepted',
  'offer declined': 'offerDeclined',
  rejected: 'rejected',
  'no answer': 'noAnswer',
  ghosted: 'noAnswer',
}

// "Heard back" = any human reply, INCLUDING rejections. Powers the first stat
// card, the sources chart, and the velocity overlay. Deliberately distinct
// from the interview rate (which requires reaching the Interviewed stage) —
// do not collapse them. See CLAUDE.md.
export const HEARD_BACK_BUCKETS = new Set<string>([
  'pending',
  'interviewed',
  'progressing',
  'rejected',
  'offerAccepted',
  'offerDeclined',
])

export const BUCKET_SPEC: { key: BucketKey; label: string; color: string }[] = [
  { key: 'awaiting', label: 'Awaiting Reply', color: 'amber' },
  { key: 'pending', label: 'Pending', color: 'blue' },
  { key: 'interviewed', label: 'Interviewed', color: 'olive' },
  { key: 'progressing', label: 'Progressing', color: 'plum' },
  { key: 'offerAccepted', label: 'Offer Accepted', color: 'teal' },
  { key: 'offerDeclined', label: 'Offer Declined', color: 'rust' },
  { key: 'rejected', label: 'Rejected', color: 'rust' },
  { key: 'noAnswer', label: 'No Answer', color: 'stone' },
]

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
// v8: added `stages` (how far each interview process actually got) + per-job stage.
// v9: `jobs[].id` (Notion page id) so a row can own an interview pack.
export const SCHEMA_VERSION = '10'

export const DEFAULT_STALE_DAYS = 30
export const ATTENTION_MIN_DAYS = 10
export const MAX_SOURCES = 6

export const STATUS_PROP = 'Status'
export const DATE_PROP = 'Application Date'
export const POSITION_PROP = 'Position'
export const NEXT_ACTION_PROP = 'Next Action'
// The Notion URL property the source/channel breakdown reads. Renamed from
// "Reference Link" → "Job Posting" in the 2026-07-14 schema cleanup; the old
// name silently returned null for every row (→ everything "other").
export const SOURCE_PROP = 'Job Posting'
export const SALARY_PROP = 'Salary' // number (annual); ~43% of rows populated
export const INTERVIEWED_PROP = 'Interviewed' // checkbox; added to Notion 2026-08-16 and backfilled

// How far a process actually got. Ordinal rather than semantic ("Hiring
// Manager", "Technical") because round names differ per company and ordinal
// labels stay comparable across all of them. Order here IS the ladder order.
export const STAGE_PROP = 'Furthest Stage'
export const STAGE_ORDER = ['Round 1 — Screen', 'Round 2', 'Round 3+', 'Offer']

// Notion Status option (case-insensitive) → funnel bucket.
// The live Notion enum (set 2026-07-14) is:
//   Applied · Interviewing · On Hold · Offer · Accepted · Rejected
// plus the older labels kept for back-compat with historical rows.
export const STATUS_BUCKETS: Record<string, string> = {
  applied: 'applied',
  pending: 'pending',
  interviewed: 'interviewed',
  interviewing: 'interviewed',
  progressing: 'progressing',
  // "On Hold" = employer paused/froze the req after a human reply (e.g. a role
  // frozen mid-process). Heard back, non-terminal → treat as pending so it
  // counts toward heard-back rather than vanishing into `unknown`.
  'on hold': 'pending',
  // Bare "Offer" (received, undecided) and "Accepted" both count as a landed
  // offer. If offer-received vs accepted ever needs splitting, add an "Offer
  // Declined" Notion option and map it to offerDeclined.
  offer: 'offerAccepted',
  accepted: 'offerAccepted',
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

// The 🎤 Interview Answer Bank database (Personal Life › Job Hunting). Web
// edits to a pack's cards are written back here so Notion stays the record
// of truth for his own writing. Override with the NOTION_BANK_DATABASE_ID
// var; the integration must be connected to that database or every
// write-back reports "not connected" (the KV copy still saves).
export const DEFAULT_BANK_DATABASE_ID = '02910f231fd644d6b1f3a552be3c5328'

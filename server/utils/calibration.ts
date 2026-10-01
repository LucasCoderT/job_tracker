/**
 * Calibration: does anything the system does predict a reply?
 *
 * Every application is scored, and since 2026-09-16 every one has carried a
 * Mac-built pack. On 2026-10-01 a score of 4.0 or more showed no better
 * outcome than anything else, and replies had fallen over the same weeks the
 * packs arrived. A ranking that does not predict replies is ranking the queue
 * on something else, so this puts the comparison on the dashboard, where it
 * is seen whether or not anyone thinks to ask.
 *
 * Only applications at least `staleDays` old count: by then "awaiting" has
 * become either a reply or no answer, so every group is judged on outcomes
 * rather than on how recently it was sent. That age gate, not Replied, is what
 * keeps the groups comparable; Replied's coverage is partial (see CLAUDE.md).
 *
 * Pure, so it can be checked against fake rows like aggregate().
 */
import type { Calibration, CalibrationGroup, CalibrationRow, Job, PackTestInfo, PackTestRow, PostingMeta } from '../../shared/types'
import { packArm } from '../../shared/pack-test'
import { HEARD_BACK_BUCKETS } from './config'

const bare = (id: string | null | undefined) => String(id ?? '').replace(/-/g, '').toLowerCase()
const DAY = 86_400_000

// Channel labels come from channelOf(). Grouped the way the screens split, not
// the way the replies do: a named ATS answers most often and had produced no
// screens, the employer's own site had produced most of them.
const ATS = new Set(['ashby', 'greenhouse', 'lever', 'workday', 'rippling', 'workable', 'smartrecruiters', 'bamboohr', 'icims', 'jazzhr', 'recruitee', 'teamtailor', 'breezy', 'jobvite', 'dover'])
function channelGroup(source: string | null): string {
  const s = (source ?? '').toLowerCase()
  if (!s) return 'Unknown'
  if (s === 'linkedin' || s === 'indeed') return 'LinkedIn / Indeed'
  if (ATS.has(s)) return 'A named ATS'
  return "The employer's own site"
}

function scoreBand(score: number | null | undefined): string {
  if (score == null) return 'Not scored'
  if (score >= 4) return '4.0 and up'
  if (score >= 3.5) return '3.5 to 3.9'
  return 'Under 3.5'
}

function tally(order: string[], items: { group: string; job: Job }[]): CalibrationRow[] {
  const rows = new Map(order.map((label) => [label, { label, n: 0, heard: 0, screens: 0 }]))
  for (const { group, job } of items) {
    const row = rows.get(group)
    if (!row) continue
    row.n++
    if (HEARD_BACK_BUCKETS.has(job.bucket)) row.heard++
    if (job.stage) row.screens++
  }
  return [...rows.values()].filter((r) => r.n > 0)
}

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2)
}

export function calibrate(
  jobs: Job[],
  postings: PostingMeta[],
  test: PackTestInfo | null,
  { staleDays, now, withinDays = 21 }: { staleDays: number; now: number; withinDays?: number },
): Calibration {
  const byPage = new Map(postings.filter((p) => p.notionPageId).map((p) => [bare(p.notionPageId), p]))
  const mature = jobs.filter((j) => j.ageDays !== null && j.ageDays >= staleDays)
  const linked = mature.map((job) => ({ job, posting: byPage.get(bare(job.id)) ?? null }))

  const groups: CalibrationGroup[] = [
    {
      key: 'score',
      title: 'Evaluation score',
      rows: tally(['4.0 and up', '3.5 to 3.9', 'Under 3.5', 'Not scored'], linked.map(({ job, posting }) => ({ job, group: scoreBand(posting?.score) }))),
    },
    {
      key: 'channel',
      title: 'Where it was sent',
      rows: tally(["The employer's own site", 'A named ATS', 'LinkedIn / Indeed', 'Unknown'], linked.map(({ job }) => ({ job, group: channelGroup(job.source) }))),
    },
    {
      key: 'sent',
      title: 'What went with it',
      // Only applications the site knows about can say; the rest are left out
      // rather than guessed. sentWith is recorded from the pack test on; before
      // that, a pack marked done is the evidence.
      rows: tally(['Mac-built pack', 'No pack'], linked.filter(({ posting }) => posting).map(({ job, posting }) => ({
        job,
        group: (posting!.sentWith ?? (posting!.pack === 'done' ? 'tailored' : 'base')) === 'tailored' ? 'Mac-built pack' : 'No pack',
      }))),
    },
  ]

  const days = jobs
    .filter((j) => j.date && j.repliedAt)
    .map((j) => Math.round((Date.parse(j.repliedAt!) - Date.parse(j.date!.slice(0, 10))) / DAY))
    .filter((d) => d >= 0)

  return {
    matureDays: staleDays,
    mature: mature.length,
    groups,
    replyDays: { n: days.length, median: median(days) },
    test: test?.startedAt ? packTest(jobs, byPage, test.startedAt, { now, withinDays }) : null,
  }
}

/**
 * The pack test by ASSIGNED half (intention to treat): a base-half posting he
 * built a pack for anyway still counts as base, and shows as deviated. Judged
 * on "replied within N days" among applications at least N days old, because
 * the test is younger than the 30-day gate above and would otherwise show
 * nothing for a month. Replied's undercount hits both halves alike.
 */
function packTest(jobs: Job[], byPage: Map<string, PostingMeta>, startedAt: string, { now, withinDays }: { now: number; withinDays: number }) {
  const start = startedAt.slice(0, 10)
  const rows: Record<'tailored' | 'base', PackTestRow> = {
    tailored: { arm: 'tailored', sent: 0, due: 0, replied: 0, deviated: 0 },
    base: { arm: 'base', sent: 0, due: 0, replied: 0, deviated: 0 },
  }
  for (const job of jobs) {
    const posting = byPage.get(bare(job.id))
    if (!posting || !job.date || job.date.slice(0, 10) < start) continue
    // A pack asked for before the test began was never in it.
    if (posting.packRequestedAt && posting.packRequestedAt < startedAt) continue
    const row = rows[packArm(posting.id)]
    row.sent++
    if ((posting.sentWith ?? null) && posting.sentWith !== row.arm) row.deviated++
    const applied = Date.parse(job.date.slice(0, 10))
    if (now - applied < withinDays * DAY) continue
    row.due++
    if (job.repliedAt && Date.parse(job.repliedAt) - applied <= withinDays * DAY) row.replied++
  }
  return { startedAt, withinDays, rows: [rows.tailored, rows.base] }
}

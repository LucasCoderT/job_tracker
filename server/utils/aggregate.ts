/**
 * Server-side aggregation. Fetches nothing — takes raw Notion pages and folds
 * them into the /api/stats payload. Ported verbatim from the original Worker;
 * the invariants in CLAUDE.md ("Testing") must hold:
 *   - total = sum of all non-unknown buckets
 *   - sum of links out of `applications` === total
 *   - each stage's inflow === its outflow
 *   - sources totals sum to total; weekly.applied sums to dated-row count
 */
import type {
  BucketKey,
  Counts,
  Job,
  AttentionItem,
  Source,
  RoleStat,
  SalaryGroup,
  SalaryContext,
  Stats,
} from '../../shared/types'
import type { NotionPage } from '../../shared/types'
import {
  ATTENTION_MIN_DAYS,
  MAX_SOURCES,
  BUCKET_SPEC,
  HEARD_BACK_BUCKETS,
  POSITION_PROP,
  NEXT_ACTION_PROP,
  SOURCE_PROP,
  SALARY_PROP,
  DATE_PROP,
} from './config'
import {
  classify,
  classifyRole,
  ROLE_ORDER,
  readInterviewed,
  readTitle,
  readRichText,
  readSelect,
  readUrl,
  readNumber,
  readDateMs,
  channelOf,
  weekStartISO,
} from './notion'

// Median/min/max over a numeric array (empty → zeroes).
function summarize(arr: number[]): SalaryGroup {
  if (!arr.length) return { n: 0, median: 0, min: 0, max: 0 }
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
  return { n: s.length, median, min: s[0]!, max: s[s.length - 1]! }
}

export function aggregate(
  pages: NotionPage[],
  { staleDays, now }: { staleDays: number; now: number },
): Stats {
  const staleMs = staleDays * 24 * 60 * 60 * 1000
  const dayMs = 24 * 60 * 60 * 1000

  const counts: Counts = {
    awaiting: 0,
    pending: 0,
    interviewed: 0,
    progressing: 0,
    offerAccepted: 0,
    offerDeclined: 0,
    rejected: 0,
    rejectedAfterInterview: 0,
    noAnswer: 0,
    unknown: 0,
  }
  const jobs: Job[] = []
  const attention: AttentionItem[] = []
  const weekMap = new Map<string, { applied: number; replied: number }>()
  const sourceMap = new Map<string, { total: number; replied: number }>()
  const roleMap = new Map<string, { total: number; replied: number }>()
  // Salary split by whether the app ever got a reply (heardBack) vs stayed
  // silent (awaiting/noAnswer). Those two buckets partition every row.
  const salaryHeard: number[] = []
  const salarySilent: number[] = []

  for (const page of pages) {
    const bucket = classify(page, { staleMs, now }) as BucketKey | null
    if (!bucket) {
      counts.unknown++
      continue
    }
    counts[bucket]++
    if (bucket === 'rejected' && readInterviewed(page)) {
      counts.rejectedAfterInterview++
    }

    const dateIso = page.properties?.[DATE_PROP]?.date?.start ?? null
    const dateMs = readDateMs(page)
    const ageDays = dateMs !== null ? Math.floor((now - dateMs) / dayMs) : null
    const replied = HEARD_BACK_BUCKETS.has(bucket)
    const nextAction = readSelect(page, NEXT_ACTION_PROP)
    const source = channelOf(readUrl(page, SOURCE_PROP))
    const salary = readNumber(page, SALARY_PROP)

    const job: Job = {
      company: readTitle(page) || 'Untitled',
      position: readRichText(page, POSITION_PROP),
      bucket,
      date: dateIso,
      ageDays,
      url: page.url ?? null,
      salary,
      source,
      nextAction,
    }
    jobs.push(job)

    // Attention queue.
    const isTerminal =
      bucket === 'rejected' || bucket === 'offerAccepted' || bucket === 'offerDeclined'
    if (nextAction === 'Follow up' && !isTerminal) {
      attention.push({ ...job, reason: 'followup' })
    } else if (bucket === 'awaiting' && ageDays !== null && ageDays >= ATTENTION_MIN_DAYS) {
      attention.push({ ...job, reason: 'aging' })
    }

    // Weekly velocity (by application week; replied = eventually got any reply).
    if (dateIso) {
      const week = weekStartISO(dateIso)
      if (week) {
        const w = weekMap.get(week) || { applied: 0, replied: 0 }
        w.applied++
        if (replied) w.replied++
        weekMap.set(week, w)
      }
    }

    // Source breakdown.
    const domain = source || 'unknown'
    const src = sourceMap.get(domain) || { total: 0, replied: 0 }
    src.total++
    if (replied) src.replied++
    sourceMap.set(domain, src)

    // Role-type breakdown.
    const role = classifyRole(job.position)
    const rm = roleMap.get(role) || { total: 0, replied: 0 }
    rm.total++
    if (replied) rm.replied++
    roleMap.set(role, rm)

    // Salary context (ignore sub-$1k values — hourly/typo, e.g. a stray "55").
    if (salary !== null && salary >= 1000) {
      ;(replied ? salaryHeard : salarySilent).push(salary)
    }
  }

  jobs.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  // Follow-ups first, then oldest aging first.
  attention.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === 'followup' ? -1 : 1
    return (b.ageDays ?? 0) - (a.ageDays ?? 0)
  })

  // Continuous weekly series from first to last week.
  const weekly: Stats['weekly'] = []
  if (weekMap.size) {
    const keys = [...weekMap.keys()].sort()
    let cur = keys[0]!
    const last = keys[keys.length - 1]!
    while (cur <= last) {
      const w = weekMap.get(cur) || { applied: 0, replied: 0 }
      weekly.push({ week: cur, applied: w.applied, replied: w.replied })
      const d = new Date(cur + 'T00:00:00Z')
      d.setUTCDate(d.getUTCDate() + 7)
      cur = d.toISOString().slice(0, 10)
    }
  }

  // Top sources by volume; the rest folded into "other".
  const sorted = [...sourceMap.entries()].sort((a, b) => b[1].total - a[1].total)
  const sources: Source[] = []
  const other = { total: 0, replied: 0 }
  for (const [domain, s] of sorted) {
    if (sources.length < MAX_SOURCES && domain !== 'unknown') {
      sources.push({ domain, ...s })
    } else {
      other.total += s.total
      other.replied += s.replied
    }
  }
  if (other.total) sources.push({ domain: 'other', ...other })

  // Roles in a fixed lane order (only lanes that actually appear).
  const roles: RoleStat[] = ROLE_ORDER.filter((r) => roleMap.has(r)).map((r) => {
    const x = roleMap.get(r)!
    return { role: r, total: x.total, replied: x.replied }
  })

  const salary: SalaryContext = {
    overall: summarize([...salaryHeard, ...salarySilent]),
    heardBack: summarize(salaryHeard),
    silent: summarize(salarySilent),
  }

  const total =
    counts.awaiting +
    counts.pending +
    counts.interviewed +
    counts.progressing +
    counts.offerAccepted +
    counts.offerDeclined +
    counts.rejected +
    counts.noAnswer

  const offers = counts.offerAccepted + counts.offerDeclined
  // Ladder: Pending → Interviewed → Progressing → Offers. A row's current
  // status implies it passed through the earlier stages ("ever reached").
  const everProgressing = counts.progressing + offers
  const everInterviewed = counts.interviewed + everProgressing + counts.rejectedAfterInterview
  const everPending = counts.pending + everInterviewed
  const heardBack =
    counts.pending + counts.interviewed + counts.progressing + offers + counts.rejected
  const rejectedBeforeInterview = counts.rejected - counts.rejectedAfterInterview

  return {
    generatedAt: new Date(now).toISOString(),
    staleDays,
    total,
    counts,
    buckets: BUCKET_SPEC.map((b) => ({
      ...b,
      label: b.key === 'noAnswer' ? `No Answer (>${staleDays}d)` : b.label,
      count: counts[b.key],
    })),
    jobs,
    attention,
    weekly,
    sources,
    roles,
    salary,
    metrics: {
      heardBack,
      interviewed: everInterviewed,
      offers,
      heardBackRate: total ? heardBack / total : 0,
      interviewRate: total ? everInterviewed / total : 0,
      offerRate: total ? offers / total : 0,
    },
    sankey: {
      nodes: [
        { id: 'applications', label: 'Applications' },
        { id: 'pending', label: 'Pending' },
        { id: 'interviewed', label: 'Interviewed' },
        { id: 'progressing', label: 'Progressing' },
        { id: 'awaiting', label: 'Awaiting Reply' },
        { id: 'rejected', label: 'Rejected' },
        { id: 'noAnswer', label: 'No Answer' },
        { id: 'offers', label: 'Offers' },
        { id: 'accepted', label: 'Offer Accepted' },
        { id: 'declined', label: 'Offer Declined' },
      ],
      links: [
        { source: 'applications', target: 'pending', value: everPending },
        { source: 'applications', target: 'awaiting', value: counts.awaiting },
        { source: 'applications', target: 'rejected', value: rejectedBeforeInterview },
        { source: 'applications', target: 'noAnswer', value: counts.noAnswer },
        { source: 'pending', target: 'interviewed', value: everInterviewed },
        { source: 'interviewed', target: 'progressing', value: everProgressing },
        { source: 'interviewed', target: 'rejected', value: counts.rejectedAfterInterview },
        { source: 'progressing', target: 'offers', value: offers },
        { source: 'offers', target: 'accepted', value: counts.offerAccepted },
        { source: 'offers', target: 'declined', value: counts.offerDeclined },
      ],
    },
  }
}

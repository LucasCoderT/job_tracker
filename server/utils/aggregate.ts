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
  StageStat,
  SankeySpec,
  SankeyNodeSpec,
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
  STAGE_ORDER,
} from './config'
import {
  classify,
  classifyRole,
  ROLE_ORDER,
  readInterviewed,
  readStage,
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
    pendingAfterInterview: 0,
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
  // Furthest rung reached, counted per process, split by how it ended there.
  // Turned into a cumulative ladder after the loop so "reached" answers
  // "how many got at least this far".
  const stageStopped = new Map<string, number>()
  const stageStoppedRejected = new Map<string, number>()
  const stageStoppedOpen = new Map<string, number>()

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
    // A row can sit in `pending` ("On Hold" = req frozen mid-process) after an
    // interview already happened. Without this the Interviewed checkbox is
    // ignored for those rows and the interview rate under-reports.
    if (bucket === 'pending' && readInterviewed(page)) {
      counts.pendingAfterInterview++
    }

    const dateIso = page.properties?.[DATE_PROP]?.date?.start ?? null
    const dateMs = readDateMs(page)
    const ageDays = dateMs !== null ? Math.floor((now - dateMs) / dayMs) : null
    const replied = HEARD_BACK_BUCKETS.has(bucket)
    const nextAction = readSelect(page, NEXT_ACTION_PROP)
    const source = channelOf(readUrl(page, SOURCE_PROP))
    const salary = readNumber(page, SALARY_PROP)
    const stage = readStage(page)
    if (stage) {
      stageStopped.set(stage, (stageStopped.get(stage) ?? 0) + 1)
      // Where the process went after its furthest rung: closed out, or still
      // live (in-process, or paused by the employer).
      const sink = bucket === 'rejected' ? stageStoppedRejected : stageStoppedOpen
      sink.set(stage, (sink.get(stage) ?? 0) + 1)
    }

    const job: Job = {
      id: String(page.id ?? page.url ?? ''),
      company: readTitle(page) || 'Untitled',
      position: readRichText(page, POSITION_PROP),
      bucket,
      date: dateIso,
      ageDays,
      url: page.url ?? null,
      salary,
      source,
      nextAction,
      stage,
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
  const everInterviewed =
    counts.interviewed +
    everProgressing +
    counts.rejectedAfterInterview +
    counts.pendingAfterInterview
  // pendingAfterInterview rows are inside BOTH counts.pending and
  // everInterviewed, so subtract them once to avoid double-counting the stage.
  const pendingBeforeInterview = counts.pending - counts.pendingAfterInterview
  const everPending = pendingBeforeInterview + everInterviewed
  const heardBack =
    counts.pending + counts.interviewed + counts.progressing + offers + counts.rejected
  const rejectedBeforeInterview = counts.rejected - counts.rejectedAfterInterview

  // Cumulative ladder: walk the rungs from deepest back to shallowest so
  // `reached` accumulates ("got at least this far"), while `stoppedHere` stays
  // the count whose process ended on that exact rung.
  let carried = 0
  const stages: StageStat[] = STAGE_ORDER.map((stage) => ({
    stage,
    reached: 0,
    stoppedHere: stageStopped.get(stage) ?? 0,
  }))
  for (let i = stages.length - 1; i >= 0; i--) {
    carried += stages[i]!.stoppedHere
    stages[i]!.reached = carried
  }

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
    stages,
    sankey: buildSankey({
      counts,
      stages,
      stageStoppedRejected,
      stageStoppedOpen,
      everPending,
      pendingBeforeInterview,
      rejectedBeforeInterview,
      offers,
    }),
  }
}

/**
 * The interview ladder, folded into the Sankey. The old diagram collapsed every
 * interview into one "Interviewed" node, which hid how far each process got.
 * Now each round is its own rung: flow moves rightward to the next round, and
 * peels off to Rejected or Still Open at whichever rung the process ended on.
 *
 * Rungs with no traffic are dropped, along with any node left unreferenced, so
 * the diagram never renders empty stages (d3-sankey chokes on orphan nodes).
 */
function buildSankey(input: {
  counts: Counts
  stages: StageStat[]
  stageStoppedRejected: Map<string, number>
  stageStoppedOpen: Map<string, number>
  everPending: number
  pendingBeforeInterview: number
  rejectedBeforeInterview: number
  offers: number
}): SankeySpec {
  const {
    counts,
    stages,
    stageStoppedRejected,
    stageStoppedOpen,
    everPending,
    pendingBeforeInterview,
    rejectedBeforeInterview,
    offers,
  } = input

  const rungId = (i: number) => `stage${i}`
  // The trailing "Offer" rung is represented by the existing offers nodes, so
  // the ladder rungs drawn here are the interview rounds only.
  const rungs = stages.slice(0, -1)

  const nodes: SankeyNodeSpec[] = [
    { id: 'applications', label: 'Applications' },
    { id: 'pending', label: 'Heard Back' },
    ...rungs.map((s, i) => ({ id: rungId(i), label: s.stage })),
    { id: 'offers', label: 'Offers' },
    { id: 'accepted', label: 'Offer Accepted' },
    { id: 'declined', label: 'Offer Declined' },
    { id: 'stillOpen', label: 'Still Open' },
    { id: 'awaiting', label: 'Awaiting Reply' },
    { id: 'rejected', label: 'Rejected' },
    { id: 'noAnswer', label: 'No Answer' },
  ]

  const links: SankeySpec['links'] = [
    { source: 'applications', target: 'pending', value: everPending },
    { source: 'applications', target: 'awaiting', value: counts.awaiting },
    { source: 'applications', target: 'rejected', value: rejectedBeforeInterview },
    { source: 'applications', target: 'noAnswer', value: counts.noAnswer },
    // Heard back but never interviewed, and not yet closed out.
    { source: 'pending', target: 'stillOpen', value: pendingBeforeInterview },
  ]

  // Each rung emits only its INCOMING edge plus its two drop-offs. Emitting an
  // "onward" edge here as well would draw every rung-to-rung link twice.
  rungs.forEach((rung, i) => {
    const from = i === 0 ? 'pending' : rungId(i - 1)
    links.push({ source: from, target: rungId(i), value: rung.reached })
    links.push({
      source: rungId(i),
      target: 'rejected',
      value: stageStoppedRejected.get(rung.stage) ?? 0,
    })
    links.push({
      source: rungId(i),
      target: 'stillOpen',
      value: stageStoppedOpen.get(rung.stage) ?? 0,
    })
  })

  // The last rung feeds the offers nodes, which stand in for the Offer stage.
  const lastRung = rungs.length - 1
  const offerStage = stages[stages.length - 1]
  if (lastRung >= 0 && offerStage) {
    links.push({ source: rungId(lastRung), target: 'offers', value: offerStage.reached })
  }

  links.push({ source: 'offers', target: 'accepted', value: counts.offerAccepted })
  links.push({ source: 'offers', target: 'declined', value: counts.offerDeclined })

  const live = links.filter((l) => l.value > 0)
  const used = new Set(live.flatMap((l) => [l.source, l.target]))
  return { nodes: nodes.filter((n) => used.has(n.id)), links: live }
}

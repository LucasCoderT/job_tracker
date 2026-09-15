/**
 * Assembles one EI week out of things the site can prove *he* did.
 *
 * The distinction this file exists to hold: the Mac evaluates postings, builds
 * CVs and drafts form answers on a schedule, often overnight. None of that is
 * his job-search time and none of it produces a candidate row. What does:
 *
 *   pressed "Mark applied"           → Applied online            (appliedAt)
 *   pressed "Build pack"             → Resume/cover letter prep  (packRequestedAt)
 *   dismissed a posting              → Searched online           (dismissedAt)
 *   pasted / edited a form's answers,
 *     or asked for them to be drafted → Resume/cover letter prep  (the questions record)
 *   marked a job rejected or moved on → Email application        (activity events)
 *
 * **Every timestamp above is one only his action writes.** That is the whole
 * trick, and it was wrong once: dismissals and questions used to be dated by
 * the posting's `updatedAt`, which every producer push stamps — so a posting
 * the eval worker re-pushed overnight showed up as something he did that day.
 * Never date a candidate by `updatedAt`.
 *
 * Each candidate carries the timestamps behind it so he can check it against
 * his own memory and drop anything that did not happen the way it looks, and
 * a suggested time with the arithmetic behind it. The suggestion is a starting
 * value on screen, never a write — see ei-notion.ts.
 */
import type {
  ActivityEvent,
  EiCandidate,
  EiLogged,
  EiMethod,
  EiTimeSpent,
  NotionPage,
  PostingMeta,
  PostingQuestions,
} from '../../shared/types'
import { EI_TIMEZONE, DATE_PROP, POSITION_PROP } from './config'
import { readTitle, readRichText } from './notion'

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: EI_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const timeFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: EI_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** YYYY-MM-DD in his timezone — the day he would say he did it. */
export function localDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : dateFmt.format(d)
}
function localTime(iso: string): string {
  return timeFmt.format(new Date(iso))
}
function stamp(iso: string): string {
  return `${localDate(iso)} ${localTime(iso)}`
}

/** The Monday of the EI week containing `day` (YYYY-MM-DD), and its Sunday. */
export function weekBounds(day: string): { monday: string; sunday: string } {
  const d = new Date(`${day}T12:00:00Z`)
  const dow = d.getUTCDay() // 0 Sun … 6 Sat
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow))
  const monday = d.toISOString().slice(0, 10)
  d.setUTCDate(d.getUTCDate() + 6)
  return { monday, sunday: d.toISOString().slice(0, 10) }
}

/** Today in his timezone — "this week" must mean his week, not UTC's. */
export function todayLocal(): string {
  return dateFmt.format(new Date())
}

const inWeek = (day: string | null, monday: string, sunday: string) => !!day && day >= monday && day <= sunday
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

type Draft = Omit<EiCandidate, 'suggested' | 'suggestedWhy'> & { units: number }

function push(
  map: Map<string, Draft>,
  key: string,
  base: { date: string; method: EiMethod; activity: string; outcome: EiCandidate['outcome']; subject: string },
  note: string,
  evidence: string,
  units = 1,
) {
  const found = map.get(key)
  if (found) {
    if (note && !found.notes.split('; ').includes(note)) found.notes = found.notes ? `${found.notes}; ${note}` : note
    found.evidence.push(evidence)
    found.units += units
    return
  }
  map.set(key, { key, ...base, notes: note, evidence: [evidence], alreadyLogged: false, sameDayLogged: [], units })
}

/**
 * A starting time for a row, from what the evidence counts — and the sum
 * shown beside it, so the number is checkable rather than a black box. Round
 * figures on purpose: the Notion column only has four options, and false
 * precision would read as measurement when it is an estimate.
 */
const MINUTES: [prefix: string, per: number, unit: string, many?: string][] = [
  ['applied:', 30, 'application'],
  ['notion:', 30, 'application'],
  ['prep:', 30, 'tailored CV and cover letter', 'tailored CVs and cover letters'],
  ['questions:', 10, 'form question'],
  ['search:', 5, 'posting reviewed', 'postings reviewed'],
  ['correspondence:', 15, 'employer update'],
]
function suggest(d: Draft): { suggested: EiTimeSpent; suggestedWhy: string } {
  const [, per, unit, many] = MINUTES.find(([p]) => d.key.startsWith(p)) ?? ['', 30, 'activity', 'activities']
  const minutes = Math.max(30, d.units * per)
  const suggested: EiTimeSpent =
    minutes <= 30 ? '30 min' : minutes <= 60 ? '1 hour' : minutes <= 90 ? '1.5 hours' : '2 hours'
  // Say when the column's options bent the sum, or "1 posting × 5 min" sits
  // beside "30 min" and looks like an error.
  const raw = d.units * per
  const bent = raw < 30 ? ', rounded up to the shortest entry' : raw > 120 ? ', capped at the longest entry' : ''
  return { suggested, suggestedWhy: `${plural(d.units, unit, many)} × ${per} min${bent}` }
}

/**
 * A logged row on the same day, same method, naming the same company is this
 * activity already recorded. Matched on the company rather than the sentence,
 * because his own entries are written freehand and no two are phrased alike.
 *
 * Deliberately conservative: a summary row ("Submitted four applications")
 * names no company and so matches nothing, which leaves the four candidates
 * standing. That is the right way round — the page shows him what is already
 * logged for the day next to them, and dropping a row he can see is duplicated
 * costs a tap, while a silent double-entry lands in a record Service Canada
 * audits and he would never know.
 */
function markLogged(candidates: EiCandidate[], logged: EiLogged[]) {
  for (const c of candidates) {
    const subject = c.subject.trim().toLowerCase()
    const sameDay = logged.filter((l) => l.date === c.date && l.method === c.method)
    if (subject.length >= 4) {
      c.alreadyLogged = sameDay.some((l) => l.activity.toLowerCase().includes(subject))
    }
    // What the day already holds under this method. A summary row he wrote
    // himself ("Submitted four applications") names no employer and so cannot
    // be matched, but seeing it next to the row is enough to decide.
    if (!c.alreadyLogged) {
      c.sameDayLogged = sameDay.map((l) => `${l.activity}${l.timeSpent ? ` (${l.timeSpent})` : ''}`)
    }
  }
}

export function buildCandidates(
  postings: PostingMeta[],
  pages: NotionPage[],
  logged: EiLogged[],
  monday: string,
  sunday: string,
  questionsById: Map<string, PostingQuestions> = new Map(),
  events: ActivityEvent[] = [],
): EiCandidate[] {
  const map = new Map<string, Draft>()
  // Applications already represented by a site posting, by Notion page id.
  // Matching on company+date does NOT work here: the site's appliedAt becomes
  // a local date while Notion's Application Date is the UTC one, so an evening
  // application lands a day apart in the two sources and every one of them
  // would be proposed twice. The page id is the same fact in both.
  const claimed = new Set<string>()
  // A posting pushed thin (a friend's link) can have no company; the Notion
  // row it created does. Prefer the better name.
  const nameFor = new Map<string, string>()
  for (const page of pages) nameFor.set(String(page.id).replace(/-/g, ''), readTitle(page))

  for (const p of postings) {
    const pageKey = p.notionPageId ? p.notionPageId.replace(/-/g, '') : ''
    // A thin push can carry a placeholder rather than a blank — one real
    // posting's company is the single character "?" — so test for a usable
    // name, not just a truthy one.
    const named = (v: string | null | undefined) => (v && !/^[?\-–—.\s]*$/.test(v) ? v.trim() : '')
    const company = named(p.company) || named(pageKey ? nameFor.get(pageKey) : '') || 'an employer'
    const who = `${company}${p.role ? ` — ${p.role}` : ''}`

    // Marked applied: the application itself, one row per employer.
    const applied = localDate(p.appliedAt)
    if (inWeek(applied, monday, sunday)) {
      if (pageKey) claimed.add(pageKey)
      push(
        map,
        `applied:${p.id}`,
        { date: applied!, method: 'Applied online', activity: `Applied to ${who}`, outcome: 'Applied', subject: company },
        p.url,
        `marked applied on the tracker at ${stamp(p.appliedAt!)}`,
      )
    }

    // Asked for a tailored CV and cover letter, then sent it.
    const requested = localDate(p.packRequestedAt)
    if (inWeek(requested, monday, sunday)) {
      push(
        map,
        `prep:${requested}`,
        {
          date: requested!,
          method: 'Resume/cover letter prep',
          activity: 'Prepared tailored resumes and cover letters',
          outcome: 'Applied',
          subject: '',
        },
        company,
        `requested an apply pack for ${who} at ${stamp(p.packRequestedAt!)}`,
      )
    }

    // Dismissed: he read it and said no. That is the reviewing.
    const dismissed = p.state === 'dismissed' ? localDate(p.dismissedAt) : null
    if (inWeek(dismissed, monday, sunday)) {
      push(
        map,
        `search:${dismissed}`,
        {
          date: dismissed!,
          method: 'Searched online',
          activity: 'Reviewed job postings and shortlisted openings',
          outcome: 'No suitable postings found',
          subject: '',
        },
        company,
        `dismissed ${who} at ${stamp(p.dismissedAt!)}`,
      )
    }

    // A form's supplemental questions. His part is pasting them, editing the
    // answers and asking for a draft; the draft itself is the Mac's, so an
    // answer whose text came from a draft contributes nothing here.
    const q = questionsById.get(p.id)
    if (q) {
      const byDay = new Map<string, string[]>()
      const add = (iso: string | null | undefined, what: string) => {
        const day = localDate(iso)
        if (!inWeek(day, monday, sunday)) return
        byDay.set(day!, [...(byDay.get(day!) ?? []), `${what} at ${stamp(iso!)}`])
      }
      const pasted = q.questions.filter((x) => x.source === 'pasted')
      const edited = q.questions.filter((x) => x.source === 'edited')
      for (const x of pasted) add(x.updatedAt, `entered "${x.question.slice(0, 60)}"`)
      for (const x of edited) add(x.updatedAt, `edited the answer to "${x.question.slice(0, 60)}"`)
      add(q.requestedAt, `asked for drafts of ${plural(q.questions.length, 'question')}`)
      for (const [day, evidence] of byDay) {
        for (const e of evidence) {
          push(
            map,
            `questions:${p.id}:${day}`,
            {
              date: day,
              method: 'Resume/cover letter prep',
              activity: `Completed ${company}'s application questions`,
              outcome: 'Applied',
              subject: company,
            },
            `${plural(q.questions.length, 'question')} on the ${company} form`,
            e,
            0,
          )
        }
        // Sized by the form, not by how many timestamps it left behind.
        map.get(`questions:${p.id}:${day}`)!.units = q.questions.length
      }
    }
  }

  // Status changes he made from the tracker: the reply came in, he recorded it.
  for (const e of events) {
    if (!inWeek(e.day, monday, sunday)) continue
    const what = e.action === 'reject' ? 'rejection' : e.stage === 'Offer' ? 'offer' : `moved on to ${e.stage}`
    push(
      map,
      `correspondence:${e.day}`,
      {
        date: e.day,
        method: 'Email application',
        activity: 'Processed employer correspondence',
        outcome: 'Waiting on reply',
        subject: '',
      },
      `${e.company}: ${what}`,
      `marked ${e.company} ${e.action === 'reject' ? 'rejected' : `as ${e.stage}`} at ${stamp(e.at)}`,
    )
    // An interview being set up is the outcome worth recording, if any update
    // that day was one.
    if (e.action === 'advance' && e.stage !== 'Offer') map.get(`correspondence:${e.day}`)!.outcome = 'Interview scheduled'
  }

  // Applications that never went through the site — referred, applied direct,
  // or logged straight into Notion. Without these the week under-reports.
  for (const page of pages) {
    const iso = (page.properties?.[DATE_PROP] as any)?.date?.start
    const day = iso ? iso.slice(0, 10) : null
    if (!inWeek(day, monday, sunday)) continue
    if (claimed.has(String(page.id).replace(/-/g, ''))) continue
    const company = readTitle(page)
    if (!company) continue
    const role = readRichText(page, POSITION_PROP)
    push(
      map,
      `notion:${page.id}`,
      {
        date: day!,
        method: 'Applied online',
        activity: `Applied to ${company}${role ? ` — ${role}` : ''}`,
        outcome: 'Applied',
        subject: company,
      },
      '',
      `application row in Notion dated ${day}`,
    )
  }

  const candidates: EiCandidate[] = [...map.values()]
    .map(({ units, ...c }) => ({ ...c, ...suggest({ ...c, units } as Draft) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.method.localeCompare(b.method))
  markLogged(candidates, logged)
  return candidates
}

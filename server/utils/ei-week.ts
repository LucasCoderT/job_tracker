/**
 * Assembles one EI week out of things the site can prove *he* did.
 *
 * The distinction this file exists to hold: the Mac evaluates postings, builds
 * CVs and drafts form answers on a schedule, often overnight. None of that is
 * his job-search time and none of it produces a candidate row. What does:
 *
 *   pressed "Mark applied"      → Applied online
 *   pressed "Build pack"        → Resume/cover letter prep  (he chose the job
 *                                 and reviewed what came back before sending)
 *   dismissed a posting         → Searched online  (a human decision on a real
 *                                 posting, which is what "reviewed" means)
 *   pasted a form's questions   → Resume/cover letter prep
 *
 * Each candidate carries the timestamps behind it so he can check it against
 * his own memory and drop anything that did not happen the way it looks. No
 * candidate carries a `timeSpent` — see ei-notion.ts.
 */
import type { EiCandidate, EiLogged, EiMethod, PostingMeta, NotionPage } from '../../shared/types'
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

function push(
  map: Map<string, EiCandidate>,
  key: string,
  base: { date: string; method: EiMethod; activity: string; outcome: EiCandidate['outcome']; subject: string },
  note: string,
  evidence: string,
) {
  const found = map.get(key)
  if (found) {
    if (note && !found.notes.includes(note)) found.notes = found.notes ? `${found.notes}; ${note}` : note
    found.evidence.push(evidence)
    return
  }
  map.set(key, { key, ...base, notes: note, evidence: [evidence], alreadyLogged: false, sameDayLogged: [] })
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
): EiCandidate[] {
  const map = new Map<string, EiCandidate>()
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
          subject: company,
        },
        company,
        `requested an apply pack for ${who} at ${stamp(p.packRequestedAt!)}`,
      )
    }

    // Dismissed: he read it and said no. That is the reviewing.
    if (p.state === 'dismissed') {
      const seen = localDate(p.updatedAt)
      if (inWeek(seen, monday, sunday)) {
        push(
          map,
          `search:${seen}`,
          {
            date: seen!,
            method: 'Searched online',
            activity: 'Reviewed job postings and shortlisted openings',
            outcome: 'No suitable postings found',
            subject: company,
          },
          company,
          `dismissed ${who} at ${stamp(p.updatedAt)}`,
        )
      }
    }

    // Pasted a form's supplemental questions off the employer's site.
    if (p.questions > 0) {
      const q = localDate(p.updatedAt)
      if (inWeek(q, monday, sunday)) {
        push(
          map,
          `questions:${p.id}`,
          {
            date: q!,
            method: 'Resume/cover letter prep',
            activity: `Completed ${company}'s application questions`,
            outcome: 'Applied',
            subject: company,
          },
          `${p.questions} question${p.questions === 1 ? '' : 's'} on the ${company} form`,
          `${p.questions} questions entered for ${who}, ${p.answered} answered`,
        )
      }
    }
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

  const candidates = [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.method.localeCompare(b.method))
  markLogged(candidates, logged)
  return candidates
}

/**
 * Fake Notion pages for local dev when NOTION_TOKEN is absent. Shaped exactly
 * like the real Notion query results the readers in notion.ts expect, so the
 * whole aggregate() → /api/stats → dashboard path runs end-to-end offline.
 *
 * Dates are computed relative to `now` so the Awaiting-vs-No-Answer cutoff and
 * the weekly velocity series populate realistically.
 */
import type { NotionPage } from '../../shared/types'

const DAY = 24 * 60 * 60 * 1000

const SOURCE_URLS: Record<string, string> = {
  linkedin: 'https://www.linkedin.com/jobs/view/000',
  indeed: 'https://ca.indeed.com/viewjob?jk=000',
  ashby: 'https://jobs.ashbyhq.com/acme/000',
  greenhouse: 'https://boards.greenhouse.io/acme/jobs/000',
  workday: 'https://acme.wd1.myworkdayjobs.com/careers/job/000',
}

interface Spec {
  company: string
  position: string
  status: string
  daysAgo: number
  source: keyof typeof SOURCE_URLS
  nextAction?: string
  interviewed?: boolean
}

// A believable ~6-month funnel: lots of Applied (some fresh, many stale),
// a handful of replies, fewer interviews, two live Progressing, one offer.
const SPECS: Spec[] = [
  // Fresh applied → "Awaiting Reply"
  { company: 'Northwind', position: 'Full-Stack Engineer', status: 'Applied', daysAgo: 2, source: 'ashby' },
  { company: 'Contoso', position: 'Backend Engineer', status: 'Applied', daysAgo: 5, source: 'greenhouse' },
  { company: 'Fabrikam', position: 'Software Engineer', status: 'Applied', daysAgo: 6, source: 'linkedin' },
  { company: 'Tailspin', position: 'Platform Engineer', status: 'Applied', daysAgo: 9, source: 'linkedin' },
  { company: 'Proseware', position: 'Full-Stack Developer', status: 'Applied', daysAgo: 12, source: 'indeed', nextAction: 'Follow up' },
  { company: 'Wingtip', position: 'Backend Developer', status: 'Applied', daysAgo: 16, source: 'ashby' },
  { company: 'Litware', position: 'Software Engineer II', status: 'Applied', daysAgo: 22, source: 'workday' },

  // Stale applied (> 30d) → "No Answer"
  { company: 'Adventure Works', position: 'Backend Engineer', status: 'Applied', daysAgo: 34, source: 'linkedin' },
  { company: 'Coho Vineyard', position: 'Full-Stack Engineer', status: 'Applied', daysAgo: 41, source: 'indeed' },
  { company: 'Graphic Design Inst', position: 'Web Developer', status: 'Applied', daysAgo: 48, source: 'linkedin' },
  { company: 'Lucerne Publishing', position: 'Software Engineer', status: 'Applied', daysAgo: 55, source: 'indeed' },
  { company: 'Margie’s Travel', position: 'Backend Engineer', status: 'Applied', daysAgo: 63, source: 'linkedin' },
  { company: 'School of Fine Art', position: 'Full-Stack Engineer', status: 'Applied', daysAgo: 71, source: 'indeed' },
  { company: 'Trey Research', position: 'Platform Engineer', status: 'Applied', daysAgo: 80, source: 'linkedin' },

  // Pending (replied, in early conversation)
  { company: 'Blue Yonder', position: 'Full-Stack Engineer', status: 'Pending', daysAgo: 14, source: 'ashby', nextAction: 'Follow up' },
  { company: 'Alpine Ski House', position: 'Backend Engineer', status: 'Pending', daysAgo: 20, source: 'greenhouse' },

  // Interviewed
  { company: 'Woodgrove Bank', position: 'AI/ML Engineer', status: 'Interviewed', daysAgo: 26, source: 'ashby' },

  // Progressing (live)
  { company: 'Fourth Coffee', position: 'AI Platform Engineer', status: 'Progressing', daysAgo: 30, source: 'greenhouse', nextAction: 'Follow up' },
  { company: 'VanArsdel', position: 'Data/ML Engineer', status: 'Progressing', daysAgo: 37, source: 'workday' },

  // Offers
  { company: 'Consolidated Messenger', position: 'Full-Stack Engineer', status: 'Offer Accepted', daysAgo: 44, source: 'ashby' },
  { company: 'City Power & Light', position: 'Backend Engineer', status: 'Offer Declined', daysAgo: 52, source: 'greenhouse' },

  // Rejections — one after interviewing (routes through the Interviewed stage)
  { company: 'The Phone Company', position: 'Software Engineer', status: 'Rejected', daysAgo: 33, source: 'linkedin' },
  { company: 'Humongous Insurance', position: 'Backend Engineer', status: 'Rejected', daysAgo: 40, source: 'indeed' },
  { company: 'Nod Publishers', position: 'Full-Stack Engineer', status: 'Rejected', daysAgo: 47, source: 'linkedin' },
  { company: 'Southridge Video', position: 'Platform Engineer', status: 'Rejected', daysAgo: 58, source: 'workday', interviewed: true },
  { company: 'Wide World Importers', position: 'Software Engineer', status: 'Rejected', daysAgo: 66, source: 'linkedin' },
]

function makePage(spec: Spec, i: number, now: number): NotionPage {
  const dateIso = new Date(now - spec.daysAgo * DAY).toISOString().slice(0, 10)
  const properties: Record<string, any> = {
    Company: { type: 'title', title: [{ plain_text: spec.company }] },
    Position: { type: 'rich_text', rich_text: [{ plain_text: spec.position }] },
    Status: { type: 'select', select: { name: spec.status } },
    'Application Date': { type: 'date', date: { start: dateIso } },
    'Job Posting': { type: 'url', url: SOURCE_URLS[spec.source] },
  }
  if (spec.nextAction) {
    properties['Next Action'] = { type: 'select', select: { name: spec.nextAction } }
  }
  if (spec.interviewed) {
    properties.Interviewed = { type: 'checkbox', checkbox: true }
  }
  // Deterministic pseudo-salary; leave ~1/4 unset to mirror real coverage.
  if (i % 4 !== 0) {
    properties.Salary = { type: 'number', number: 95000 + ((i * 7) % 12) * 6000 }
  }
  return {
    id: `mock-${i}`,
    url: `https://www.notion.so/mock-${i}`,
    properties,
  }
}

export function mockPages(now: number): NotionPage[] {
  return SPECS.map((spec, i) => makePage(spec, i, now))
}

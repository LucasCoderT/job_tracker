/**
 * POST /api/ei/entries — append the rows he confirmed to the Notion log.
 *
 * Every row must carry a `timeSpent` from the closed set. A row without one is
 * rejected rather than defaulted: this is his declaration to Service Canada
 * about his own hours, and a plausible guess in that column would be the site
 * putting words in his mouth on an audited form.
 */
import type { EiEntryInput, EiWriteResult } from '../../../shared/types'
import { EI_TIME_OPTIONS } from '#shared/types'
import { getCloudflareEnv } from '../../utils/notion'
import { writeEntries } from '../../utils/ei-notion'

const METHODS = new Set([
  'Networking',
  'Searched online',
  'Applied online',
  'Email application',
  'Attended interview',
  'Resume/cover letter prep',
])
const OUTCOMES = new Set(['Waiting on reply', 'Applied', 'No suitable postings found', 'Interview scheduled'])

export default defineEventHandler(async (event): Promise<EiWriteResult> => {
  const env = getCloudflareEnv(event)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const raw = Array.isArray(body.entries) ? body.entries : []
  if (!raw.length) throw createError({ statusCode: 400, statusMessage: 'Nothing to write.' })
  if (raw.length > 60) throw createError({ statusCode: 413, statusMessage: 'At most 60 entries at a time.' })

  const entries: EiEntryInput[] = raw.map((e: any, i: number) => {
    const where = `Entry ${i + 1}`
    const date = String(e?.date ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw createError({ statusCode: 400, statusMessage: `${where}: a date is required.` })
    const activity = String(e?.activity ?? '').trim()
    if (!activity) throw createError({ statusCode: 400, statusMessage: `${where}: an activity is required.` })
    if (!METHODS.has(e?.method)) throw createError({ statusCode: 400, statusMessage: `${where}: unknown method.` })
    if (!OUTCOMES.has(e?.outcome)) throw createError({ statusCode: 400, statusMessage: `${where}: unknown outcome.` })
    if (!EI_TIME_OPTIONS.includes(e?.timeSpent)) {
      throw createError({ statusCode: 400, statusMessage: `${where} (${activity}): set the time spent — the site will not guess it.` })
    }
    return { date, activity, method: e.method, outcome: e.outcome, timeSpent: e.timeSpent, notes: String(e?.notes ?? '').trim() }
  })

  return await writeEntries(env, entries)
})

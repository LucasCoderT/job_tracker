/**
 * GET /api/ei/week?monday=YYYY-MM-DD — one EI week, assembled.
 *
 * Returns candidate rows (what the site can prove he did, with the evidence)
 * and what is already in the Notion log for that week. Nothing here writes,
 * and no candidate carries a `timeSpent` — that is his to set.
 */
import type { EiWeek, NotionPage, PostingQuestions } from '../../../shared/types'
import { getCloudflareEnv, queryAllPages } from '../../utils/notion'
import { listPostings, getQuestions } from '../../utils/postings'
import { listActivity } from '../../utils/activity'
import { readWeek } from '../../utils/ei-notion'
import { buildCandidates, weekBounds, todayLocal } from '../../utils/ei-week'

export default defineEventHandler(async (event): Promise<EiWeek> => {
  const env = getCloudflareEnv(event)
  const asked = String(getQuery(event).monday ?? '').trim()
  const today = todayLocal()
  const { monday, sunday } = weekBounds(/^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : today)

  if (!env.POSTINGS) {
    return { enabled: false, monday, sunday, today, candidates: [], logged: [], error: 'No POSTINGS binding on this deploy.' }
  }

  const kv = env.POSTINGS
  const postings = await listPostings(kv)

  // The questions records carry the only timestamps his form work leaves (see
  // ei-week.ts); a handful of postings have any, so one read each is fine.
  const withQuestions = postings.filter((p) => p.questions > 0)
  const questionsById = new Map<string, PostingQuestions>()
  await Promise.all(
    withQuestions.map(async (p) => {
      const q = await getQuestions(kv, p.id)
      if (q) questionsById.set(p.id, q)
    }),
  )
  // A missing event list costs suggested rows, not the page.
  const events = await listActivity(kv, monday, sunday).catch(() => [])

  // The applications database, for anything applied to outside the site.
  let pages: NotionPage[] = []
  try {
    pages = await queryAllPages(env)
  } catch {
    // A tracker outage must not hide the site-side evidence, which is the
    // part that is otherwise recorded nowhere.
    pages = []
  }

  // The log itself is the one thing worth failing loudly about: without it
  // every candidate would come back unmarked and he would double-log a week
  // into a record Service Canada reads.
  let logged
  try {
    logged = await readWeek(env, monday, sunday)
  } catch (err: any) {
    return {
      enabled: true,
      monday,
      sunday,
      today,
      candidates: [],
      logged: [],
      error: String(err?.message || err).slice(0, 400),
    }
  }

  return {
    enabled: true,
    monday,
    sunday,
    today,
    candidates: buildCandidates(postings, pages, logged, monday, sunday, questionsById, events),
    logged,
    error: null,
  }
})

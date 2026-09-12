/**
 * GET /api/ei/week?monday=YYYY-MM-DD — one EI week, assembled.
 *
 * Returns candidate rows (what the site can prove he did, with the evidence)
 * and what is already in the Notion log for that week. Nothing here writes,
 * and no candidate carries a `timeSpent` — that is his to set.
 */
import type { EiWeek, NotionPage } from '../../../shared/types'
import { getCloudflareEnv, queryAllPages } from '../../utils/notion'
import { listPostings } from '../../utils/postings'
import { readWeek } from '../../utils/ei-notion'
import { buildCandidates, weekBounds, todayLocal } from '../../utils/ei-week'

export default defineEventHandler(async (event): Promise<EiWeek> => {
  const env = getCloudflareEnv(event)
  const asked = String(getQuery(event).monday ?? '').trim()
  const { monday, sunday } = weekBounds(/^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : todayLocal())

  if (!env.POSTINGS) {
    return { enabled: false, monday, sunday, candidates: [], logged: [], error: 'No POSTINGS binding on this deploy.' }
  }

  const postings = await listPostings(env.POSTINGS)

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
      candidates: [],
      logged: [],
      error: String(err?.message || err).slice(0, 400),
    }
  }

  return { enabled: true, monday, sunday, candidates: buildCandidates(postings, pages, logged, monday, sunday), logged, error: null }
})

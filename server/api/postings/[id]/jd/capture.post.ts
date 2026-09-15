/**
 * POST /api/postings/:id/jd/capture — fetch the job description now.
 *
 * The brief's "Fetch it" button, and the backfill. Waits for the fetch so the
 * page can show the result or the reason it failed ("Indeed blocks automated
 * fetches"). A JD already stored is kept — see jd-store.ts.
 */
import type { PostingDetail } from '../../../../../shared/types'
import { postingContext, requirePosting } from '../../../../utils/posting-route'
import { getAnalysis } from '../../../../utils/postings'
import { captureForPosting } from '../../../../utils/jd-store'

export default defineEventHandler(async (event): Promise<PostingDetail & { error: string | null }> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const res = await captureForPosting(ctx.env, ctx.kv, meta)
  return { meta: res.meta ?? meta, jd: res.jd, analysis: await getAnalysis(ctx.kv, ctx.id), error: res.error }
})

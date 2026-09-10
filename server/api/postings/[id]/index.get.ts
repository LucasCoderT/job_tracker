/** GET /api/postings/:id — the meta plus the JD and the evaluation. */
import type { PostingDetail } from '../../../../shared/types'
import { postingContext, requirePosting } from '../../../utils/posting-route'
import { getJD, getAnalysis } from '../../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingDetail> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const [jd, analysis] = await Promise.all([getJD(ctx.kv, ctx.id), getAnalysis(ctx.kv, ctx.id)])
  return { meta, jd, analysis }
})

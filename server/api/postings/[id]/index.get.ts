/** GET /api/postings/:id — the meta plus the JD and the evaluation. */
import type { PostingDetail } from '../../../../shared/types'
import { postingContext, requirePosting } from '../../../utils/posting-route'
import { getJD, getAnalysis } from '../../../utils/postings'
import { getPackTest } from '../../../utils/pack-test'

export default defineEventHandler(async (event): Promise<PostingDetail> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const [jd, analysis, packTest] = await Promise.all([getJD(ctx.kv, ctx.id), getAnalysis(ctx.kv, ctx.id), getPackTest(ctx.kv)])
  return { meta, jd, analysis, packTest: packTest ?? undefined }
})

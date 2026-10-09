/** GET /api/postings/:id — the meta plus the JD and the evaluation. */
import type { PostingDetail } from '../../../../shared/types'
import { postingContext, requirePosting } from '../../../utils/posting-route'
import { getJD, getAnalysis } from '../../../utils/postings'
import { getPackTest } from '../../../utils/pack-test'
import { readFacts, forPosting } from '../../../utils/facts'

export default defineEventHandler(async (event): Promise<PostingDetail> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const [jd, analysis, packTest, facts] = await Promise.all([
    getJD(ctx.kv, ctx.id),
    getAnalysis(ctx.kv, ctx.id),
    getPackTest(ctx.kv),
    // The brief still renders if this read fails; it just has no questions on it.
    readFacts(ctx.kv).catch(() => null),
  ])
  return { meta, jd, analysis, packTest: packTest ?? undefined, open: facts ? forPosting(facts, ctx.id) : undefined }
})

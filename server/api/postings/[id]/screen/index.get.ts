/** GET /api/postings/:id/screen — the first-call prep for this posting. */
import type { ScreenPrep } from '../../../../../shared/types'
import { postingContext, requirePosting } from '../../../../utils/posting-route'
import { getAnalysis } from '../../../../utils/postings'
import { buildPrep } from '../../../../utils/screen'

export default defineEventHandler(async (event): Promise<ScreenPrep> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const analysis = await getAnalysis(ctx.kv, ctx.id)
  return await buildPrep(ctx.kv, meta, analysis)
})

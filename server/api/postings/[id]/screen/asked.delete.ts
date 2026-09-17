/**
 * DELETE /api/postings/:id/screen/asked?prompt=<id> — drop a recorded question.
 *
 * A question typed wrongly, or one recorded by mistake, would otherwise appear
 * on every screen prep from now on with no way to take it back.
 */
import type { ScreenPrep } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { getAnalysis } from '../../../../utils/postings'
import { removeAsked, buildPrep } from '../../../../utils/screen'

export default defineEventHandler(async (event): Promise<ScreenPrep> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const promptId = String(getQuery(event).prompt ?? '')
  if (!promptId) throw createError({ statusCode: 400, statusMessage: 'Which question?' })
  await removeAsked(ctx.kv, promptId, now())
  return await buildPrep(ctx.kv, meta, await getAnalysis(ctx.kv, ctx.id))
})

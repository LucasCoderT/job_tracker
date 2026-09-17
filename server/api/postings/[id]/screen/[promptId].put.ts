/**
 * PUT /api/postings/:id/screen/:promptId — save one prepared answer.
 *
 * A standing answer is also written to the standing document, so the next
 * screen he prepares for starts from what he wrote here.
 */
import type { ScreenPrep } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { getAnalysis } from '../../../../utils/postings'
import { saveAnswer } from '../../../../utils/screen'

export default defineEventHandler(async (event): Promise<ScreenPrep> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const promptId = String(getRouterParam(event, 'promptId') ?? '')
  const body = (await readBody(event).catch(() => ({}))) ?? {}

  const analysis = await getAnalysis(ctx.kv, ctx.id)
  try {
    return await saveAnswer(ctx.kv, meta, analysis, promptId, body.answer ?? '', now())
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'That prompt is not on this screen prep.' })
  }
})

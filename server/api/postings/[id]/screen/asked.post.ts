/**
 * POST /api/postings/:id/screen/asked — record a question he was actually asked.
 *
 * At one interview per eighteen applications, a real question from a real call
 * is the rarest input the system gets. Recorded here it becomes a prompt on
 * every future screen prep, so each call prepares the next one.
 */
import type { ScreenPrep } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { getAnalysis } from '../../../../utils/postings'
import { addAsked, buildPrep } from '../../../../utils/screen'

export default defineEventHandler(async (event): Promise<ScreenPrep> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}

  try {
    await addAsked(ctx.kv, body.text ?? '', meta.company, now())
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Type the question they asked.' })
  }
  return await buildPrep(ctx.kv, meta, await getAnalysis(ctx.kv, ctx.id))
})

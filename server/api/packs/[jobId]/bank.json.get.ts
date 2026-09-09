/** GET /api/packs/:jobId/bank.json — the bank exactly as InterviewHelper imports it. */
import { packContext, requireMeta } from '../../../utils/pack-route'
import { getBank } from '../../../utils/packs'

export default defineEventHandler(async (event) => {
  const ctx = packContext(event)
  const meta = await requireMeta(ctx)
  const bank = await getBank(ctx.kv, ctx.jobId)
  if (!bank) throw createError({ statusCode: 404, statusMessage: 'This pack has no bank yet.' })
  setHeader(event, 'content-type', 'application/json;charset=utf-8')
  setHeader(event, 'content-disposition', `inline; filename="${meta.slug}.json"`)
  return JSON.stringify(bank, null, 2)
})

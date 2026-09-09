/** GET /api/packs/:jobId/prep.html — the printable prep sheet, rendered from the bank. */
import { packContext, requireMeta } from '../../../utils/pack-route'
import { getBank, prepSheetHTML } from '../../../utils/packs'

export default defineEventHandler(async (event) => {
  const ctx = packContext(event)
  const meta = await requireMeta(ctx)
  const bank = await getBank(ctx.kv, ctx.jobId)
  if (!bank) throw createError({ statusCode: 404, statusMessage: 'This pack has no bank yet.' })
  setHeader(event, 'content-type', 'text/html;charset=utf-8')
  return prepSheetHTML(bank, meta)
})

/** GET /api/packs/:jobId/exports/:name — a published export, served as itself. */
import { packContext } from '../../../../utils/pack-route'
import { getExport, safeExportName } from '../../../../utils/packs'

export default defineEventHandler(async (event) => {
  const ctx = packContext(event)
  const name = safeExportName(getRouterParam(event, 'name') ?? '')
  const found = await getExport(ctx.kv, ctx.jobId, name)
  if (!found) throw createError({ statusCode: 404, statusMessage: 'No such export.' })
  setHeader(event, 'content-type', found.contentType)
  setHeader(event, 'content-disposition', `inline; filename="${name}"`)
  return found.body
})

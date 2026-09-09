/** DELETE /api/packs/:jobId/exports/:name */
import type { PackMeta } from '../../../../../shared/types'
import { packContext, requireMeta } from '../../../../utils/pack-route'
import { deleteExport, safeExportName } from '../../../../utils/packs'

export default defineEventHandler(async (event): Promise<PackMeta> => {
  const ctx = packContext(event)
  const meta = await requireMeta(ctx)
  const name = safeExportName(getRouterParam(event, 'name') ?? '')
  if (!meta.exports.some((e) => e.name === name)) throw createError({ statusCode: 404, statusMessage: 'No such export.' })
  return deleteExport(ctx.kv, meta, name)
})

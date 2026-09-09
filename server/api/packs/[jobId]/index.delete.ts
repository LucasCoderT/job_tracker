/** DELETE /api/packs/:jobId — the pack, its bank and its exports. Notion is untouched. */
import { packContext, requireMeta } from '../../../utils/pack-route'
import { deletePack } from '../../../utils/packs'

export default defineEventHandler(async (event) => {
  const ctx = packContext(event)
  const meta = await requireMeta(ctx)
  await deletePack(ctx.kv, meta)
  return { ok: true }
})

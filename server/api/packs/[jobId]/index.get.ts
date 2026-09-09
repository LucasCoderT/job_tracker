/** GET /api/packs/:jobId — meta, the bank, and its lint. */
import type { PackDetail } from '../../../../shared/types'
import { packContext, requireMeta } from '../../../utils/pack-route'
import { getBank, lint } from '../../../utils/packs'

export default defineEventHandler(async (event): Promise<PackDetail> => {
  const ctx = packContext(event)
  const meta = await requireMeta(ctx)
  const bank = await getBank(ctx.kv, ctx.jobId)
  return { meta, bank, lint: lint(bank) }
})

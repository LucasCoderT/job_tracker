/**
 * PUT /api/packs/:jobId/bank — replace the whole bank. The worker's upload
 * (`?status=done` marks the pack built in the same call) and the web
 * editor's bank-level saves (title, avoid list, deck) both land here.
 * Body: the bank JSON. Validated by the same rules as a card edit.
 */
import type { PackDetail } from '../../../../shared/types'
import { packContext, requireMeta, now } from '../../../utils/pack-route'
import { cleanBank, putBank, putMeta, withCounts, lint } from '../../../utils/packs'

export default defineEventHandler(async (event): Promise<PackDetail> => {
  const ctx = packContext(event)
  const meta = await requireMeta(ctx)
  let bank
  try {
    bank = cleanBank(await readBody(event))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  if (!bank.title) bank.title = `${meta.company}${meta.position ? ' — ' + meta.position : ''}`
  await putBank(ctx.kv, ctx.jobId, bank)
  const done = getQuery(event).status === 'done'
  const stamp = now()
  const next = withCounts(
    { ...meta, updatedAt: stamp, ...(done ? { status: 'done' as const, error: null, builtAt: stamp } : {}) },
    bank,
  )
  await putMeta(ctx.kv, next)
  return { meta: next, bank, lint: lint(bank) }
})

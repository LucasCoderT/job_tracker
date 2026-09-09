/**
 * POST /api/packs/:jobId/status — the worker reporting. Body:
 * { status: 'building' | 'done' | 'failed', error?: string }.
 * `done` without a bank upload is refused: an empty "done" pack would be a
 * lie the phone believes.
 */
import type { PackMeta } from '../../../../shared/types'
import { packContext, requireMeta, now } from '../../../utils/pack-route'
import { STATUSES, getBank, putMeta, withCounts } from '../../../utils/packs'

export default defineEventHandler(async (event): Promise<PackMeta> => {
  const ctx = packContext(event)
  const meta = await requireMeta(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const status = String(body.status ?? '')
  if (!STATUSES.includes(status as any) || status === 'requested') {
    throw createError({ statusCode: 400, statusMessage: 'status must be building, done or failed.' })
  }
  const bank = await getBank(ctx.kv, ctx.jobId)
  if (status === 'done' && !bank) {
    throw createError({ statusCode: 409, statusMessage: 'Upload the bank before marking the pack done.' })
  }
  const stamp = now()
  const next = withCounts(
    {
      ...meta,
      status: status as PackMeta['status'],
      error: status === 'failed' ? String(body.error ?? 'failed').slice(0, 2000) : null,
      builtAt: status === 'done' ? stamp : meta.builtAt,
      updatedAt: stamp,
    },
    bank,
  )
  await putMeta(ctx.kv, next)
  return next
})

/**
 * POST /api/postings/:id/pack/status — the Mac reporting. Body:
 * { status: 'building' | 'done' | 'failed', error?: string }.
 *
 * `done` with nothing uploaded is refused: a "Ready" pack with no CV behind
 * it is a lie the phone believes, and he would find out at the worst moment.
 */
import type { PostingMeta } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { putMeta } from '../../../../utils/postings'

const REPORTABLE = ['building', 'done', 'failed'] as const

export default defineEventHandler(async (event): Promise<PostingMeta> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const status = String(body.status ?? '')
  if (!REPORTABLE.includes(status as any)) {
    throw createError({ statusCode: 400, statusMessage: 'status must be building, done or failed.' })
  }
  if (status === 'done' && !meta.artifacts.length) {
    throw createError({ statusCode: 409, statusMessage: 'Upload the CV before marking the pack done.' })
  }
  const stamp = now()
  const next: PostingMeta = {
    ...meta,
    pack: status as PostingMeta['pack'],
    packError: status === 'failed' ? String(body.error ?? 'failed').slice(0, 2000) : null,
    packBuiltAt: status === 'done' ? stamp : meta.packBuiltAt,
    updatedAt: stamp,
  }
  await putMeta(ctx.kv, next)
  return next
})

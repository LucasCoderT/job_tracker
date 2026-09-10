/**
 * POST /api/postings/:id/state — his decision. Body: { state: 'new' | 'dismissed' }.
 *
 * `applied` is deliberately not settable here: it is a side effect of the
 * Notion row being written, and claiming it without the row would put a job
 * in the funnel's story that the funnel has never heard of.
 */
import type { PostingMeta } from '../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../utils/posting-route'
import { putMeta } from '../../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingMeta> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const state = String(body.state ?? '')
  if (state !== 'new' && state !== 'dismissed') {
    throw createError({ statusCode: 400, statusMessage: 'state must be new or dismissed.' })
  }
  const next: PostingMeta = { ...meta, state, updatedAt: now() }
  await putMeta(ctx.kv, next)
  return next
})

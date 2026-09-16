/**
 * POST /api/postings/:id/opened — he has now read this one.
 *
 * Sets `openedAt` the first time and never again, so the dashboard's unread
 * marker means "never opened", not "not opened recently". A separate call
 * rather than a side effect of GET /:id: a read should not write, and the
 * brief is also rendered server-side for a link he may never look at.
 */
import type { PostingMeta } from '../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../utils/posting-route'
import { putMeta } from '../../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingMeta> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  if (meta.openedAt) return meta
  const next: PostingMeta = { ...meta, openedAt: now() }
  await putMeta(ctx.kv, next)
  return next
})

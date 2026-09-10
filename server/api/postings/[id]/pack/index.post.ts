/**
 * POST /api/postings/:id/pack — "Build pack". Queues the Mac to tailor a CV
 * and cover letter for this posting. Body: { note?: string }.
 *
 * A rebuild leaves the existing files downloadable until new ones replace
 * them: the phone should never lose the CV it was about to send because a
 * regenerate was pressed.
 */
import type { PostingMeta } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { putMeta } from '../../../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingMeta> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const stamp = now()
  const next: PostingMeta = {
    ...meta,
    pack: 'requested',
    packNote: String(body.note ?? meta.packNote ?? '').trim().slice(0, 2000),
    packError: null,
    packRequestedAt: stamp,
    updatedAt: stamp,
  }
  await putMeta(ctx.kv, next)
  return next
})

/**
 * POST /api/postings/:id/pack — "Build pack". Queues the Mac to tailor a CV
 * and cover letter for this posting. Body: { note?: string, leaveTest?: boolean }.
 *
 * A rebuild leaves the existing files downloadable until new ones replace
 * them: the phone should never lose the CV it was about to send because a
 * regenerate was pressed.
 */
import type { PostingMeta } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { putMeta } from '../../../../utils/postings'
import { announce, commandWorkers } from '../../../../utils/realtime'
import { getPackTest } from '../../../../utils/pack-test'
import { inPackTest, packArm } from '../../../../../shared/pack-test'

export default defineEventHandler(async (event): Promise<PostingMeta> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  // The pack test (shared/pack-test.ts). Refused here and not only in the UI,
  // because the listing's bulk build and any future caller come through this
  // route too. `leaveTest: true` is the explicit way out, and the posting then
  // counts as tailored, which the analysis can see.
  if (!body.leaveTest && packArm(meta.id) === 'base' && inPackTest(meta, await getPackTest(ctx.kv))) {
    throw createError({ statusCode: 409, statusMessage: 'This posting is in the base-CV half of the pack test.' })
  }
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
  // This is the route the detail page's "Build pack" hits. Tell the UI, and
  // wake the Mac so it starts now instead of on its next 20-minute poll.
  announce(event, 'pack.requested', ctx.id, { kind: 'apply', company: next.company, role: next.role, status: 'requested' })
  commandWorkers(event, 'build-pack', { id: ctx.id })
  return next
})

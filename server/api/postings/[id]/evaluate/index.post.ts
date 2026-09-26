/**
 * POST /api/postings/:id/evaluate — "Re-evaluate". Body: { note?: string }.
 *
 * The evaluation worker drains postings *without a valid evaluation*, so a
 * posting that already has one is invisible to it and re-running by hand was
 * the only way to get a fresh read. That is exactly what he needed twice this
 * week: once when a JD arrived after the evaluation was written from nothing,
 * and once when the first pass had scored a stub with no company or role.
 *
 * Two mechanisms, the same pair the pack flow uses. `commandWorkers` wakes the
 * Mac so it starts in about a second, and `evalStatus: 'requested'` is the
 * queue — read from the listing the worker already fetches — so a request made
 * while the Mac is asleep is honoured when it wakes rather than lost with the
 * socket.
 *
 * It does not delete the existing evaluation. The worker replaces the report in
 * place, keeping its number, and until it does the brief should go on showing
 * the evaluation he has: an empty brief for however long the run takes would
 * lose him the very thing he is asking to improve.
 */
import type { PostingMeta } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { putMeta } from '../../../../utils/postings'
import { announce, commandWorkers } from '../../../../utils/realtime'

export default defineEventHandler(async (event): Promise<PostingMeta> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)

  // Already queued or running: say so rather than bumping the timestamp and
  // letting a second tap look like it started something new.
  if (meta.evalStatus === 'requested' || meta.evalStatus === 'building') {
    throw createError({
      statusCode: 409,
      statusMessage:
        meta.evalStatus === 'building'
          ? 'This posting is being evaluated right now.'
          : 'A re-evaluation is already queued for this posting.',
    })
  }

  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const stamp = now()
  const next: PostingMeta = {
    ...meta,
    evalStatus: 'requested',
    evalNote: String(body.note ?? '').trim().slice(0, 2000),
    evalError: null,
    evalRequestedAt: stamp,
    updatedAt: stamp,
  }
  await putMeta(ctx.kv, next)
  announce(event, 'eval.requested', ctx.id, {
    company: next.company,
    role: next.role,
    status: 'requested',
  })
  commandWorkers(event, 'evaluate', { id: ctx.id })
  return next
})

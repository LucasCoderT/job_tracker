/**
 * POST /api/postings/:id/evaluate/status — the Mac reporting on a requested
 * re-evaluation. Body: { status: 'building' | 'done' | 'failed', error? }.
 *
 * `done` is refused unless an evaluation is actually stored, the same
 * lie-prevention as the pack's artifact check and the questions' answer check.
 * A "re-evaluated" badge on a posting whose analysis never arrived would send
 * him to read a brief that says nothing new.
 *
 * Note the asymmetry with `done`: a *failed* run still clears the queue, so a
 * posting the worker gave up on does not sit in `requested` forever asking to
 * be picked up again. The reason is kept on the meta and shown on the brief.
 */
import type { PostingMeta } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { putMeta } from '../../../../utils/postings'
import { announce } from '../../../../utils/realtime'

const REPORTABLE = ['building', 'done', 'failed'] as const

export default defineEventHandler(async (event): Promise<PostingMeta> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const status = String(body.status ?? '')
  if (!REPORTABLE.includes(status as any)) {
    throw createError({ statusCode: 400, statusMessage: 'status must be building, done or failed.' })
  }
  if (status === 'done' && !meta.hasAnalysis) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Push the evaluation before marking it done.',
    })
  }

  const stamp = now()
  const next: PostingMeta = {
    ...meta,
    evalStatus: status as PostingMeta['evalStatus'],
    evalError: status === 'failed' ? String(body.error ?? 'failed').slice(0, 2000) : null,
    updatedAt: stamp,
  }
  await putMeta(ctx.kv, next)
  announce(event, `eval.${status}` as 'eval.building' | 'eval.done' | 'eval.failed', ctx.id, {
    company: next.company,
    role: next.role,
    status: next.evalStatus,
    score: next.score,
    error: next.evalError,
  })
  return next
})

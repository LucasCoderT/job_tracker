/**
 * POST /api/postings/:id/questions/request — "Draft answers".
 *
 * Queues the Mac to answer the form's questions through career-ops's
 * modes/apply.md. Refused with nothing to answer: a queued draft of zero
 * questions would sit in the worker's queue forever looking like work.
 *
 * Body: { note?: string } — steers tone and emphasis for the whole draft.
 */
import type { PostingQuestions } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { getQuestions, putQuestions, putMeta, withQuestionCounts } from '../../../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingQuestions> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const existing = await getQuestions(ctx.kv, ctx.id)
  if (!existing?.questions.length) {
    throw createError({ statusCode: 409, statusMessage: 'Paste the questions before asking for answers.' })
  }

  const stamp = now()
  const next: PostingQuestions = {
    ...existing,
    status: 'requested',
    note: body.note !== undefined ? String(body.note).trim().slice(0, 2000) : existing.note,
    requestedAt: stamp,
    error: null,
    updatedAt: stamp,
  }
  await putQuestions(ctx.kv, ctx.id, next)
  await putMeta(ctx.kv, withQuestionCounts({ ...meta, updatedAt: stamp }, next))
  return next
})

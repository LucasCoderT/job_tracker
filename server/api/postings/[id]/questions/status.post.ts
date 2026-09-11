/**
 * POST /api/postings/:id/questions/status — the Mac reporting.
 * Body: { status: 'building' | 'done' | 'failed', error?: string }.
 *
 * `done` with nothing answered is refused, the same lie-prevention the pack
 * and bank routes use: a draft marked ready with empty answers is found out
 * at the worst moment, in front of the form.
 */
import type { PostingQuestions } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { getQuestions, putQuestions, putMeta, withQuestionCounts } from '../../../../utils/postings'

const REPORTABLE = ['building', 'done', 'failed'] as const

export default defineEventHandler(async (event): Promise<PostingQuestions> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const status = String(body.status ?? '')
  if (!REPORTABLE.includes(status as any)) {
    throw createError({ statusCode: 400, statusMessage: 'status must be building, done or failed.' })
  }
  const existing = await getQuestions(ctx.kv, ctx.id)
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'No questions for this posting.' })
  if (status === 'done' && !existing.questions.some((q) => q.answer.trim())) {
    throw createError({ statusCode: 409, statusMessage: 'Upload the answers before marking the draft done.' })
  }

  const stamp = now()
  const next: PostingQuestions = {
    ...existing,
    status: status as PostingQuestions['status'],
    error: status === 'failed' ? String(body.error ?? 'failed').slice(0, 2000) : null,
    builtAt: status === 'done' ? stamp : existing.builtAt,
    updatedAt: stamp,
  }
  await putQuestions(ctx.kv, ctx.id, next)
  await putMeta(ctx.kv, withQuestionCounts({ ...meta, updatedAt: stamp }, next))
  return next
})

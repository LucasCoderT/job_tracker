/**
 * POST /api/postings/:id/questions/parse-status — the Mac reporting on a re-parse.
 *
 * Body: { status: 'building' | 'done' | 'failed', error? }
 */
import type { PostingQuestions, AnswerStatus } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { getQuestions, putQuestions, putMeta, withQuestionCounts, ANSWER_STATUSES } from '../../../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingQuestions> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const status = String(body.status ?? '') as AnswerStatus
  if (!ANSWER_STATUSES.includes(status)) {
    throw createError({ statusCode: 400, statusMessage: `status must be one of ${ANSWER_STATUSES.join(', ')}` })
  }
  const existing = await getQuestions(ctx.kv, ctx.id)
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'No questions on this posting.' })

  const stamp = now()
  const next: PostingQuestions = {
    ...existing,
    parseStatus: status,
    parseError: body.error ? String(body.error).slice(0, 2000) : status === 'failed' ? 'The Mac could not re-read it.' : null,
    updatedAt: stamp,
  }
  await putQuestions(ctx.kv, ctx.id, next)
  await putMeta(ctx.kv, withQuestionCounts({ ...meta, updatedAt: stamp }, next))
  return next
})

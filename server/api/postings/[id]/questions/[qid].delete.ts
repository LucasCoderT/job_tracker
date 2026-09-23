/**
 * DELETE /api/postings/:id/questions/:qid — drop one question.
 *
 * Re-pasting the whole form was the only way to remove a question, and that
 * meant reproducing the paste exactly or losing the answers already drafted for
 * the ones being kept. A form that asks something he will not answer — or a
 * line the parser turned into a question that never was one — should cost one
 * tap, not a re-paste.
 */
import type { PostingQuestions } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { getQuestions, putQuestions, putMeta, withQuestionCounts } from '../../../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingQuestions> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const qid = String(getRouterParam(event, 'qid') ?? '')
  const existing = await getQuestions(ctx.kv, ctx.id)
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'No questions on this posting.' })

  const kept = existing.questions.filter((q) => q.id !== qid)
  if (kept.length === existing.questions.length) {
    throw createError({ statusCode: 404, statusMessage: 'No question with that id.' })
  }

  const stamp = now()
  const next: PostingQuestions = { ...existing, questions: kept, updatedAt: stamp }
  await putQuestions(ctx.kv, ctx.id, next)
  await putMeta(ctx.kv, withQuestionCounts({ ...meta, updatedAt: stamp }, next))
  return next
})

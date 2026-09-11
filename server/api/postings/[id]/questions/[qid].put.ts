/**
 * PUT /api/postings/:id/questions/:qid — edit one answer from the web.
 *
 * His edit wins: the source flips to 'edited', so a later regenerate can tell
 * what he wrote from what the Mac drafted.
 *
 * Body: { answer: string }
 */
import type { PostingQuestions } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { getQuestions, putQuestions, putMeta, withQuestionCounts } from '../../../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingQuestions> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const qid = String(getRouterParam(event, 'qid') ?? '')
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  if (body.answer === undefined) throw createError({ statusCode: 400, statusMessage: 'Nothing to save.' })

  const existing = await getQuestions(ctx.kv, ctx.id)
  const found = existing?.questions.find((q) => q.id === qid)
  if (!existing || !found) throw createError({ statusCode: 404, statusMessage: 'No such question.' })

  const stamp = now()
  const next: PostingQuestions = {
    ...existing,
    questions: existing.questions.map((q) =>
      q.id === qid
        ? { ...q, answer: String(body.answer).slice(0, 20000), source: 'edited' as const, updatedAt: stamp }
        : q,
    ),
    updatedAt: stamp,
  }
  await putQuestions(ctx.kv, ctx.id, next)
  await putMeta(ctx.kv, withQuestionCounts({ ...meta, updatedAt: stamp }, next))
  return next
})

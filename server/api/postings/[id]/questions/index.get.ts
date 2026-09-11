/** GET /api/postings/:id/questions — the form's questions and their answers. */
import type { PostingQuestions } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { getQuestions, EMPTY_QUESTIONS } from '../../../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingQuestions> => {
  const ctx = postingContext(event)
  await requirePosting(ctx)
  return (await getQuestions(ctx.kv, ctx.id)) ?? EMPTY_QUESTIONS(now())
})

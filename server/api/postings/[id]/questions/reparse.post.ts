/**
 * POST /api/postings/:id/questions/reparse — have Claude re-read the paste.
 *
 * The heuristic parser is instant, free, and works when Claude does not, which
 * is why it stays the default — there have been over a thousand usage-limited
 * ticks this month, and being unable to enter questions during one would bite
 * at exactly the wrong moment. But a form is arbitrarily shaped, and when the
 * preview shows the split went wrong, something that can actually read the
 * paste should get a turn.
 *
 * Queues it for the Mac. Refused with nothing stored to re-read.
 */
import type { PostingQuestions } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { getQuestions, putQuestions, putMeta, withQuestionCounts } from '../../../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingQuestions> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const existing = await getQuestions(ctx.kv, ctx.id)
  if (!existing?.rawText?.trim()) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Nothing stored to re-read — paste the form again and it will be kept this time.',
    })
  }

  const stamp = now()
  const next: PostingQuestions = { ...existing, parseStatus: 'requested', parseError: null, updatedAt: stamp }
  await putQuestions(ctx.kv, ctx.id, next)
  await putMeta(ctx.kv, withQuestionCounts({ ...meta, updatedAt: stamp }, next))
  return next
})

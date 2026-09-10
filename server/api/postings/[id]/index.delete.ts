/** DELETE /api/postings/:id — the posting, its JD, its evaluation, its files. */
import { postingContext, requirePosting } from '../../../utils/posting-route'
import { deletePosting } from '../../../utils/postings'

export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const ctx = postingContext(event)
  await deletePosting(ctx.kv, await requirePosting(ctx))
  return { ok: true }
})

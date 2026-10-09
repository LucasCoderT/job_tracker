/** DELETE /api/postings/:id — the posting, its JD, its evaluation, its files. */
import { postingContext, requirePosting } from '../../../utils/posting-route'
import { deletePosting } from '../../../utils/postings'
import { forgetPosting } from '../../../utils/facts'

export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const ctx = postingContext(event)
  await deletePosting(ctx.kv, await requirePosting(ctx))
  // Best-effort: the posting is gone either way, and a stale asker is only a dead link.
  await forgetPosting(ctx.kv, ctx.id).catch(() => {})
  return { ok: true }
})

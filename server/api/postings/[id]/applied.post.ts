/**
 * POST /api/postings/:id/applied — "I sent it."
 *
 * Creates the DB Applications row so the posting joins the funnel, and keeps
 * the new page id on the meta: that id is what an interview pack keys on, so
 * this is also where the apply pack hands over to the interview pack.
 *
 * The KV write happens whatever Notion says — his click is a fact, and a
 * Notion outage should not make him press it twice. Already-applied is a 409
 * rather than a second row.
 */
import type { PostingApplyResult, PostingMeta } from '../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../utils/posting-route'
import { putMeta } from '../../../utils/postings'
import { createApplication } from '../../../utils/applications-notion'

export default defineEventHandler(async (event): Promise<PostingApplyResult> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  if (meta.notionPageId) {
    throw createError({ statusCode: 409, statusMessage: 'This posting is already in the tracker.' })
  }

  const notion = await createApplication(ctx.env, meta)
  const stamp = now()
  const next: PostingMeta = {
    ...meta,
    state: 'applied',
    appliedAt: stamp,
    notionPageId: notion.ok ? notion.pageId : null,
    updatedAt: stamp,
  }
  await putMeta(ctx.kv, next)
  announce(event, 'posting.applied', ctx.id, {
    company: next.company, role: next.role, appliedAt: stamp, notionOk: notion.ok,
  })
  return { meta: next, notion }
})

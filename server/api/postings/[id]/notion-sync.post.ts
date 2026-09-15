/**
 * POST /api/postings/:id/notion-sync — fill in the Notion application page.
 *
 * Adds the summary and the 📋 Job Description / 📦 Apply Pack / 📊 Analytics
 * sub-pages that are missing, and nothing else — see application-page.ts.
 * Runs on its own after "Mark applied" and whenever a JD arrives later; this
 * route is for the backfill and the "Update Notion page" link on the brief.
 */
import type { PostingMeta } from '../../../../shared/types'
import { postingContext, requirePosting } from '../../../utils/posting-route'
import { syncApplicationPage, type SyncResult } from '../../../utils/application-page'

export default defineEventHandler(async (event): Promise<SyncResult & { meta: PostingMeta }> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  if (!meta.notionPageId) throw createError({ statusCode: 409, statusMessage: 'Not in the tracker yet — mark it applied first.' })
  return { ...(await syncApplicationPage(ctx.env, ctx.kv, meta)), meta }
})

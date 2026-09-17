/**
 * POST /api/postings/reconcile — link the postings that already have a Notion row.
 *
 * Sets `state: applied`, `notionPageId` and the true `appliedAt` from Notion's
 * Application Date. Only ever fills a blank link — a posting already carrying a
 * notionPageId is left exactly as it is, so this is safe to run repeatedly and
 * can sit on a schedule.
 */
import type { ReconcileReport } from '../../utils/reconcile'
import { getCloudflareEnv } from '../../utils/notion'
import { postingsKV } from '../../utils/postings'
import { reconcile } from '../../utils/reconcile'

export default defineEventHandler(async (event): Promise<ReconcileReport> => {
  const env = getCloudflareEnv(event)
  const kv = postingsKV(env)
  if (!kv) throw createError({ statusCode: 503, statusMessage: 'No POSTINGS KV binding configured.' })
  if (!env.NOTION_TOKEN || !env.NOTION_DATABASE_ID) {
    throw createError({ statusCode: 503, statusMessage: 'Notion is not configured, so there is nothing to reconcile against.' })
  }
  return await reconcile(env, kv, { apply: true })
})

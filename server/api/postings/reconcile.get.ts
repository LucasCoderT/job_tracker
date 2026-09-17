/**
 * GET /api/postings/reconcile — which postings are applied to and do not know it.
 *
 * Read-only: it reports what POST would link, so the match can be read before
 * anything is written. See utils/reconcile.ts for why the match is exact.
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
  return await reconcile(env, kv)
})

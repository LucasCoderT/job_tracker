/**
 * GET /api/snapshot — manual snapshot trigger (Access-protected like the rest).
 * Same write as the daily cron; safe to hit anytime, same-day runs overwrite.
 * This is the reliable seed path — it runs in a real request context, so the
 * SNAPSHOTS binding is always reachable here.
 */
import { getCloudflareEnv } from '../utils/notion'
import { takeSnapshot } from '../utils/snapshot'

export default defineEventHandler(async (event) => {
  const env = getCloudflareEnv(event)
  try {
    const result = await takeSnapshot(env)
    if ('error' in result) setResponseStatus(event, 500)
    return result
  } catch (err) {
    setResponseStatus(event, 502)
    return { error: `Snapshot failed: ${(err as Error).message}` }
  }
})

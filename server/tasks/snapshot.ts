/**
 * Daily snapshot cron. Wired to `0 15 * * *` via nuxt.config `scheduledTasks`,
 * which Nitro compiles into a wrangler cron trigger at build time.
 *
 * Caveat: Cloudflare only exposes bindings during the request lifecycle, so a
 * scheduled task has no guaranteed binding accessor (see getTaskEnv). If this
 * can't reach SNAPSHOTS on a real deploy, it logs and no-ops — seed/refresh
 * manually via the Access-gated GET /api/snapshot instead. Verify on deploy.
 */
import { getTaskEnv } from '../utils/notion'
import { takeSnapshot } from '../utils/snapshot'

export default defineTask({
  meta: {
    name: 'snapshot',
    description: 'Daily Notion → KV snapshot for trend lines',
  },
  async run() {
    const env = getTaskEnv()
    const result = await takeSnapshot(env)
    if ('error' in result) {
      console.error('[snapshot task] skipped:', result.error)
      return { result: 'skipped', reason: result.error }
    }
    console.log('[snapshot task] wrote', result.snapshot.date)
    return { result: 'ok', date: result.snapshot.date }
  },
})

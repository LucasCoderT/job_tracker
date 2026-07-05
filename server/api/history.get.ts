/**
 * GET /api/history — daily snapshots from KV (empty/disabled if no SNAPSHOTS
 * binding). Feeds future trend charts. Ported from the original Worker.
 */
import type { HistoryResponse, Snapshot } from '../../shared/types'
import { getCloudflareEnv } from '../utils/notion'

export default defineEventHandler(async (event): Promise<HistoryResponse> => {
  const env = getCloudflareEnv(event)
  if (!env.SNAPSHOTS) return { enabled: false, snapshots: [] }

  const list = await env.SNAPSHOTS.list({ prefix: 'snap:', limit: 1000 })
  const snapshots = (
    await Promise.all(list.keys.map((k) => env.SNAPSHOTS!.get(k.name, 'json')))
  ).filter(Boolean) as Snapshot[]
  snapshots.sort((a, b) => a.date.localeCompare(b.date))
  return { enabled: true, snapshots }
})

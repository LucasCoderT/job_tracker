/**
 * Daily snapshot → KV, for trend lines that Notion alone can't reconstruct
 * (statuses mutate in place). Shared by GET /api/snapshot and the cron task.
 * Ported from the original Worker's takeSnapshot().
 */
import type { Snapshot } from '../../shared/types'
import type { AppEnv } from './notion'
import { queryAllPages, resolveStaleDays } from './notion'
import { aggregate } from './aggregate'

export type SnapshotResult =
  | { ok: true; snapshot: Snapshot }
  | { error: string }

export async function takeSnapshot(env: AppEnv): Promise<SnapshotResult> {
  if (!env?.SNAPSHOTS) return { error: 'No SNAPSHOTS KV binding configured.' }
  if (!env.NOTION_TOKEN || !env.NOTION_DATABASE_ID) return { error: 'Missing Notion secrets.' }

  const pages = await queryAllPages(env)
  const staleDays = resolveStaleDays(env)
  const stats = aggregate(pages, { staleDays, now: Date.now() })
  const date = new Date().toISOString().slice(0, 10)
  const snapshot: Snapshot = {
    date,
    total: stats.total,
    counts: stats.counts,
    metrics: stats.metrics,
  }
  await env.SNAPSHOTS.put('snap:' + date, JSON.stringify(snapshot))
  return { ok: true, snapshot }
}

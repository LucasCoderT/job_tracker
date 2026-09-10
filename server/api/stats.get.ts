/**
 * GET /api/stats — aggregated dashboard JSON.
 *
 * Edge-cached 5 min via caches.default, keyed by SCHEMA_VERSION so a deploy
 * never serves an old-shaped cached payload to new frontend code (bump
 * SCHEMA_VERSION in config.ts on any shape change). The cache is skipped in
 * dev / whenever caches.default is unavailable.
 *
 * With no NOTION_TOKEN/NOTION_DATABASE_ID (local dev), serves mock data so the
 * dashboard renders offline.
 */
import type { Stats } from '../../shared/types'
import { getCloudflareEnv, resolveStaleDays, queryAllPages } from '../utils/notion'
import { aggregate } from '../utils/aggregate'
import { mockPages } from '../utils/mock'
import { SCHEMA_VERSION, CACHE_TTL_SECONDS } from '../utils/config'

export default defineEventHandler(async (event): Promise<Stats | Response | { error: string }> => {
  const env = getCloudflareEnv(event)
  const useMock = !env.NOTION_TOKEN || !env.NOTION_DATABASE_ID
  const staleDays = resolveStaleDays(env)
  const now = Date.now()

  // Edge cache (real deploy only — mock/dev responses aren't cached).
  const caches = (globalThis as any).caches
  const canCache = !useMock && caches?.default
  const cacheKey = canCache
    ? new Request(new URL('/api/stats?v=' + SCHEMA_VERSION, getRequestURL(event)).toString())
    : null

  if (cacheKey) {
    const hit = await caches.default.match(cacheKey)
    if (hit) return hit
  }

  let pages
  try {
    pages = useMock ? mockPages(now) : await queryAllPages(env)
  } catch (err) {
    setResponseStatus(event, 502)
    return { error: `Notion query failed: ${(err as Error).message}` }
  }

  const stats = aggregate(pages, { staleDays, now })

  if (cacheKey) {
    const res = new Response(JSON.stringify(stats), {
      headers: {
        'content-type': 'application/json;charset=utf-8',
        'cache-control': `public, max-age=${CACHE_TTL_SECONDS}`,
      },
    })
    // waitUntil must be called ON the execution context: pulling the method
    // off it and calling it bare throws "Illegal invocation" in workerd. This
    // only runs on a cache miss, which is why it survived until a
    // SCHEMA_VERSION bump made every request a miss.
    const cfCtx = (event.context as any)?.cloudflare?.context
    const put = caches.default.put(cacheKey, res.clone())
    if (typeof cfCtx?.waitUntil === 'function') cfCtx.waitUntil(put)
    else await put
    return res
  }

  return stats
})

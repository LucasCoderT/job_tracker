/**
 * The /api/stats edge-cache key, in one place.
 *
 * stats.get.ts fills it and the status route purges it. If the two ever built
 * the key differently the purge would silently delete nothing, and a job he
 * just marked rejected would sit in its old column for five minutes on every
 * reload — so neither builds it by hand.
 */
import type { H3Event } from 'h3'
import { SCHEMA_VERSION } from './config'

export function statsCacheKey(event: H3Event): Request | null {
  const caches = (globalThis as any).caches
  if (!caches?.default) return null
  return new Request(new URL('/api/stats?v=' + SCHEMA_VERSION, getRequestURL(event)).toString())
}

/**
 * Drops the cached payload so the next load reads Notion. Per-colo, like
 * caches.default itself — which is the colo he is on, the one that matters.
 * Best effort: a failed purge costs five stale minutes, not the change.
 */
export function purgeStats(event: H3Event): void {
  const key = statsCacheKey(event)
  if (!key) return
  const del = (globalThis as any).caches.default.delete(key).catch(() => false)
  const cfCtx = (event.context as any)?.cloudflare?.context
  if (typeof cfCtx?.waitUntil === 'function') cfCtx.waitUntil(del)
}

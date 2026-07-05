import type { Stats } from '../../shared/types'

/**
 * Fetches the aggregated dashboard payload. SSR-friendly (runs server-side on
 * first load, hydrates on the client). Shares one cache key so every consumer
 * reuses the same request.
 */
export function useStats() {
  return useFetch<Stats>('/api/stats', { key: 'stats' })
}

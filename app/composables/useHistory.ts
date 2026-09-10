import { computed } from 'vue'
import type { HistoryResponse } from '../../shared/types'

/**
 * Daily snapshots from KV, for the stat-card sparklines. Lazy: a stat card
 * without a trend is still a correct stat card, so this must never hold up
 * the first paint (DESIGN.md §7.10).
 */
export function useHistory() {
  const fetchState = useFetch<HistoryResponse>('/api/history', { key: 'history', lazy: true, server: false })
  const snapshots = computed(() => fetchState.data.value?.snapshots ?? [])
  return { ...fetchState, snapshots }
}

/** A 30-day series of one metric, oldest → newest. */
export function metricSeries(
  snapshots: { metrics: Record<string, number> }[],
  key: string,
  days = 30,
): number[] {
  return snapshots
    .slice(-days)
    .map((s) => Number(s.metrics?.[key] ?? 0))
    .filter((n) => Number.isFinite(n))
}

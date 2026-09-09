import { computed } from 'vue'
import type { PackMeta, PacksResponse } from '../../shared/types'

/** Every pack's meta, keyed for the tracker rows. One request, shared. */
export function usePacks() {
  const fetchState = useFetch<PacksResponse>('/api/packs', { key: 'packs' })
  const byJob = computed(() => {
    const map = new Map<string, PackMeta>()
    for (const p of fetchState.data.value?.packs ?? []) map.set(p.jobId, p)
    return map
  })
  return { ...fetchState, byJob }
}

export const PACK_STATUS_LABEL: Record<string, string> = {
  requested: 'Requested',
  building: 'Building…',
  done: 'Ready',
  failed: 'Failed',
}

export function packSeverity(status: string): string {
  if (status === 'done') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'building') return 'info'
  return 'warn'
}

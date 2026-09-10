import { computed } from 'vue'
import type { PostingMeta, PostingsResponse } from '../../shared/types'

/** Every posting, best score first. One request, shared by the header badge. */
export function usePostings() {
  const fetchState = useFetch<PostingsResponse>('/api/postings', { key: 'postings' })
  const postings = computed(() => fetchState.data.value?.postings ?? [])
  const open = computed(() => postings.value.filter((p) => p.state === 'new'))
  return { ...fetchState, postings, open }
}

export const POSTING_STATE_LABEL: Record<string, string> = {
  new: 'New',
  dismissed: 'Dismissed',
  applied: 'Applied',
}

export const POSTING_PACK_LABEL: Record<string, string> = {
  none: 'Build pack',
  requested: 'Requested',
  building: 'Building…',
  done: 'Ready',
  failed: 'Failed',
}

export function postingStateSeverity(state: string): string {
  if (state === 'applied') return 'success'
  if (state === 'dismissed') return 'secondary'
  return 'warn'
}

/**
 * Score colour follows career-ops's own bands (4.5+ strong, 4.0-4.4 good,
 * 3.5-3.9 decent, below that it recommends against) rather than a gradient,
 * so the colour means the same thing here as it does in a report.
 */
export function scoreColor(score: number | null): string {
  if (score === null) return 'var(--faint)'
  if (score >= 4.5) return 'var(--green)'
  if (score >= 4.0) return 'var(--amber)'
  if (score >= 3.5) return 'var(--muted)'
  return 'var(--faint)'
}

import { computed } from 'vue'
import type { PostingMeta, PostingsResponse } from '../../shared/types'

/** Every posting, best score first. One request, shared by the header badge. */
export function usePostings() {
  const fetchState = useFetch<PostingsResponse>('/api/postings', { key: 'postings' })
  const postings = computed(() => fetchState.data.value?.postings ?? [])
  const open = computed(() => postings.value.filter((p) => p.state === 'new'))

  /**
   * Notion page id → the posting it came from, so a tracker row can link to
   * its own brief instead of straight out to Notion.
   *
   * Only an applied posting carries a `notionPageId`, and only a *linked* one:
   * set by "Mark applied" on the site, or by the reconcile job, which matches
   * on an exact URL or an exact company-plus-title pair and reports everything
   * weaker rather than guessing. So this map is deliberately partial, and a
   * job with no entry keeps its Notion link — there is nothing better to
   * offer it, and a dead internal link would be worse than the old behaviour.
   */
  const byNotionPage = computed(() => {
    const map = new Map<string, PostingMeta>()
    for (const p of postings.value) if (p.notionPageId) map.set(p.notionPageId, p)
    return map
  })

  // Not awaitable: Nuxt's asyncData `then` resolves to its own object, so
  // `await usePostings()` loses these helpers. A page that needs the data
  // server-side awaits useFetch directly — see pages/postings/index.vue.
  return { ...fetchState, postings, open, byNotionPage }
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

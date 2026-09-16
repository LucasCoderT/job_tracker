import { computed, ref, onMounted } from 'vue'

/**
 * Where a page was reached from, so "back" goes back there.
 *
 * A posting opened from the dashboard used to send him to /postings, which is
 * not where he was. Links carry `?from=<path>`; for anything else — a
 * bookmark, a browser back into a deep link, a link written before this
 * existed — the router's own history entry fills in after mount.
 *
 * `from` is never used as a URL, only looked up in this table, so a crafted
 * `?from=` can send him nowhere except one of these four pages.
 */
export const TRAIL_ROOTS: Record<string, string> = {
  '/': 'Pipeline',
  '/postings': 'Postings',
  '/packs': 'Interview packs',
  '/ei': 'EI activity',
}

export interface Crumb {
  label: string
  to?: string
}

/**
 * The trail for a detail page: always the dashboard, then the section he came
 * through when that is not the dashboard itself, then the page's own crumbs.
 *
 * @param tail     this page, and anything between it and the section
 *                 (the questions page passes the posting, then "Questions")
 * @param fallback the section to assume when nothing says otherwise
 */
export function useTrail(tail: () => Crumb[], fallback: string) {
  const route = useRoute()
  const router = useRouter()

  // Read after mount: history state does not exist during SSR, and reading it
  // while hydrating would make the client's first render disagree with the
  // server's markup.
  const fromHistory = ref('')
  onMounted(() => {
    const back = (router.options.history.state?.back as string) ?? ''
    fromHistory.value = String(back).split('?')[0] ?? ''
  })

  const parent = computed(() => {
    const asked = String(route.query.from ?? '').split('?')[0] ?? ''
    for (const candidate of [asked, fromHistory.value]) {
      if (candidate && candidate in TRAIL_ROOTS) return candidate
    }
    return fallback
  })

  const crumbs = computed<Crumb[]>(() => {
    const trail: Crumb[] = [{ label: TRAIL_ROOTS['/']!, to: '/' }]
    if (parent.value !== '/') trail.push({ label: TRAIL_ROOTS[parent.value] ?? 'Back', to: parent.value })
    trail.push(...tail())
    return trail
  })

  return { crumbs, parent }
}

import { computed, ref, watch, onMounted, type Ref } from 'vue'
import type { PostingMeta } from '../../shared/types'

/**
 * Next and previous from a posting's brief: the list he was just looking at,
 * in the order he was looking at it (utils/posting-views.ts, the same view and
 * sort the postings page saves).
 *
 * The case that needs care is the one triage is made of. Dismissing or
 * applying takes the current posting out of the "New" view, so it is no longer
 * in the list to step from. `last` remembers where it sat: the row that slid
 * into its place is "next", and stepping carries on down the queue instead of
 * jumping back to the top.
 *
 * Read from localStorage after mount, never during setup, so the server and
 * the client's first render agree. Until then there is no queue and the
 * control renders nothing.
 */
export function usePostingQueue(id: () => string, postings: Ref<PostingMeta[]>) {
  const saved = ref({ view: 'new', sortKey: 'age', sortDir: -1 })
  const ready = ref(false)
  onMounted(() => {
    saved.value = savedPostingQueue()
    ready.value = true
  })

  const view = computed(() => POSTING_VIEWS.find((v) => v.key === saved.value.view) ?? POSTING_VIEWS[0]!)
  const list = computed(() =>
    ready.value ? sortPostings(postings.value.filter(view.value.match), saved.value.sortKey, saved.value.sortDir) : [],
  )
  const at = computed(() => list.value.findIndex((p) => p.id === id()))

  const last = ref(-1)
  watch(at, (i) => { if (i >= 0) last.value = i }, { immediate: true })
  // A different posting starts from where *it* is, not where the last one was.
  watch(id, () => { last.value = at.value })

  const prev = computed<PostingMeta | null>(() => {
    const i = at.value >= 0 ? at.value : last.value
    return i > 0 ? (list.value[i - 1] ?? null) : null
  })
  const next = computed<PostingMeta | null>(() => {
    if (at.value >= 0) return list.value[at.value + 1] ?? null
    if (last.value >= 0) return list.value[last.value] ?? null
    return list.value[0] ?? null
  })

  const position = computed(() => {
    if (!ready.value || !list.value.length) return ''
    return at.value >= 0 ? `${at.value + 1} of ${list.value.length}` : `${list.value.length} in ${view.value.label}`
  })

  return { ready, view, list, at, prev, next, position }
}

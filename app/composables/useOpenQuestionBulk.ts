import { computed, inject, onBeforeUnmount, provide, reactive, ref, type InjectionKey } from 'vue'
import type { EmployerQuestion, ProfileQuestion } from '../../shared/types'

/**
 * "Save all" for the open-question rows on a page.
 *
 * Each row registers what it has unsaved; the page gets one count and one
 * action. The save is one request (PUT /api/facts/answers) and so one write on
 * the server, not a save per row: his answers live in a single KV document, and
 * a burst of separate read-change-writes from the browser is how a document
 * like that loses an entry.
 */
type Kind = 'about' | 'employer'
type Saved = ProfileQuestion | EmployerQuestion

export interface BulkRow {
  kind: Kind
  id: string
  /** True when there is something typed or picked that differs from what is stored. */
  dirty: () => boolean
  payload: () => { kind: Kind; id: string; answer: string; verdict: string | null }
  /** The server accepted it: leave edit mode, drop the draft, tell the page. */
  done: (q: Saved) => void
}

const KEY: InjectionKey<Map<string, BulkRow>> = Symbol('open-question-bulk')

export function provideOpenQuestionBulk() {
  const rows = reactive(new Map<string, BulkRow>()) as Map<string, BulkRow>
  provide(KEY, rows)

  const busy = ref(false)
  const note = ref<{ text: string; error: boolean } | null>(null)
  const dirtyRows = computed(() => [...rows.values()].filter((r) => r.dirty()))
  const count = computed(() => dirtyRows.value.length)

  async function saveAll() {
    const batch = dirtyRows.value
    if (!batch.length || busy.value) return
    busy.value = true
    note.value = null
    try {
      const res = await $fetch<{ about: ProfileQuestion[]; employer: EmployerQuestion[]; skipped: number }>('/api/facts/answers', {
        method: 'PUT',
        body: { items: batch.map((r) => r.payload()) },
      })
      const saved = new Map<string, Saved>([
        ...res.about.map((q) => [`about:${q.id}`, q] as [string, Saved]),
        ...res.employer.map((q) => [`employer:${q.id}`, q] as [string, Saved]),
      ])
      let n = 0
      for (const r of batch) {
        const q = saved.get(`${r.kind}:${r.id}`)
        if (!q) continue
        r.done(q)
        n++
      }
      const left = batch.length - n
      note.value = left
        ? { text: `Saved ${n}. ${left} could not be saved and ${left === 1 ? 'is' : 'are'} still in the box.`, error: true }
        : { text: `Saved ${n} ${n === 1 ? 'answer' : 'answers'}.`, error: false }
    } catch (err: any) {
      // Nothing is lost: every box still holds its text, and its draft is in the browser.
      note.value = { text: err?.data?.statusMessage || 'Could not save. Everything you typed is still here.', error: true }
    } finally {
      busy.value = false
    }
  }

  return { count, busy, note, saveAll }
}

/** A row joins the page's Save all, if the page has one. */
export function useOpenQuestionBulkRow(row: BulkRow) {
  const rows = inject(KEY, null)
  if (!rows) return
  const key = `${row.kind}:${row.id}`
  rows.set(key, row)
  onBeforeUnmount(() => {
    if (rows.get(key) === row) rows.delete(key)
  })
}

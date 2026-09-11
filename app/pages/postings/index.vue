<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import type { PostingApplyResult, PostingMeta, PostingsResponse } from '../../../shared/types'

useHead({ title: 'Postings' })

// useFetch directly rather than through usePostings(): this page needs the
// rows server-side, and only an awaited useFetch resolves before render.
// Awaiting the composable does not work — Nuxt's asyncData `then` resolves to
// its own object, so the destructured helpers come back undefined.
const { data, pending, error, refresh } = await useFetch<PostingsResponse>('/api/postings', { key: 'postings' })
const postings = computed(() => data.value?.postings ?? [])

const config = useRuntimeConfig()
const notionUrl = computed(() => config.public.notionViewUrl)

/**
 * The stamp is the newest posting's updatedAt, not "now": this list is not
 * edge-cached the way /api/stats is, so "cached 5 min" would be a lie here.
 * What he actually wants to know is whether the Mac has touched anything.
 */
const footer = computed(() => {
  const newest = postings.value
    .map((p) => p.updatedAt)
    .filter(Boolean)
    .sort()
    .pop()
  const stamp = newest ? new Date(newest).toLocaleString() : 'never'
  return `Last change ${stamp} · evaluations run hourly · packs build every 20 min`
})

/**
 * Saved views. The counts are the navigation: the number tells him whether a
 * view is worth opening before he opens it, which a row of plain tabs cannot.
 *
 * "Ready to send" is the one that earns its place — a pack built and not yet
 * sent is the only state on this page with something to do right now.
 */
const VIEWS: { key: string; label: string; dot: string; match: (p: PostingMeta) => boolean }[] = [
  { key: 'all', label: 'All', dot: 'var(--stone)', match: () => true },
  { key: 'new', label: 'New', dot: 'var(--amber)', match: (p) => p.state === 'new' },
  { key: 'ready', label: 'Ready to send', dot: 'var(--green)', match: (p) => p.pack === 'done' && p.state !== 'applied' },
  { key: 'evaluated', label: 'Evaluated', dot: 'var(--blue)', match: (p) => p.hasAnalysis },
  { key: 'applied', label: 'Applied', dot: 'var(--teal)', match: (p) => p.state === 'applied' },
  { key: 'dismissed', label: 'Dismissed', dot: 'var(--rust)', match: (p) => p.state === 'dismissed' },
]

const STORE_KEY = 'postings.view'
const view = ref('new')
const page = ref(0)
const selected = ref<Record<string, boolean>>({})

// Read in onMounted, never during setup: reading it while hydrating would make
// the client's first render disagree with the SSR markup.
onMounted(() => {
  try {
    const saved = localStorage.getItem(STORE_KEY)
    if (saved && VIEWS.some((v) => v.key === saved)) view.value = saved
  } catch {
    /* private mode, blocked storage — the default is fine */
  }
})

function pickView(key: string) {
  view.value = key
  page.value = 0
  selected.value = {}
  try {
    localStorage.setItem(STORE_KEY, key)
  } catch {
    /* the filter still works for this visit */
  }
}

// ---- filtering ----
const search = ref('')
const source = ref('all')
const grouped = ref(false)
const per = ref(12)

const matches = computed(() => {
  const q = search.value.trim().toLowerCase()
  return postings.value.filter(
    (p) =>
      (!q || `${p.company} ${p.role} ${p.source}`.toLowerCase().includes(q)) &&
      (source.value === 'all' || p.source === source.value),
  )
})

const views = computed(() =>
  VIEWS.map((v) => ({ ...v, n: matches.value.filter(v.match).length, on: view.value === v.key })),
)

const sourceOpts = computed(() => [
  { value: 'all', label: 'All sources' },
  ...[...new Set(postings.value.map((p) => p.source).filter(Boolean))].sort().map((s) => ({ value: s, label: s })),
])

const inView = computed(() => VIEWS.find((v) => v.key === view.value)?.match ?? (() => true))
const list = computed(() => matches.value.filter(inView.value))

// ---- sorting ----
const sortKey = ref('score')
const sortDir = ref(-1)
const STATE_ORDER = ['new', 'applied', 'dismissed']

function sortValue(p: PostingMeta): string | number {
  switch (sortKey.value) {
    case 'score': return p.score ?? -1
    case 'company': return p.company.toLowerCase()
    case 'comp': return p.comp || ''
    case 'geo': return p.geo || p.location || ''
    case 'source': return p.source || ''
    case 'state': return STATE_ORDER.indexOf(p.state)
    case 'age': return Date.parse(p.firstSeen || p.createdAt) || 0
    default: return 0
  }
}

function sortBy(key: string) {
  if (sortKey.value === key) sortDir.value = -sortDir.value
  else {
    sortKey.value = key
    // Score and recency read best high-first; text reads better A–Z.
    sortDir.value = key === 'score' || key === 'age' ? -1 : 1
  }
  page.value = 0
}

const sorted = computed(() =>
  [...list.value].sort((a, b) => {
    const x = sortValue(a)
    const y = sortValue(b)
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
    return cmp * sortDir.value
  }),
)

const HEADS: { key: string; label: string; right?: boolean }[] = [
  { key: 'score', label: 'Score', right: true },
  { key: 'company', label: 'Company' },
  { key: 'state', label: 'State' },
  { key: 'comp', label: 'Comp' },
  { key: 'geo', label: 'Where' },
  { key: 'source', label: 'Source' },
  { key: 'age', label: 'Seen', right: true },
  { key: '', label: 'Pack', right: true },
]

// ---- paging ----
const pageCount = computed(() => Math.max(1, Math.ceil(sorted.value.length / per.value)))
const pg = computed(() => Math.min(page.value, pageCount.value - 1))
const slice = computed(() => sorted.value.slice(pg.value * per.value, pg.value * per.value + per.value))
const rangeText = computed(() =>
  sorted.value.length
    ? `${pg.value * per.value + 1}–${Math.min(sorted.value.length, pg.value * per.value + per.value)} of ${sorted.value.length}`
    : '0 of 0',
)
const pageButtons = computed(() => {
  const start = Math.max(0, Math.min(pg.value - 2, pageCount.value - 5))
  const out: number[] = []
  for (let i = start; i < Math.min(pageCount.value, start + 5); i++) out.push(i)
  return out
})

// ---- grouping ----
const STATE_LABEL: Record<string, string> = { new: 'New', applied: 'Applied', dismissed: 'Dismissed' }
const STATE_DOT: Record<string, string> = { new: 'var(--amber)', applied: 'var(--teal)', dismissed: 'var(--rust)' }

const groups = computed(() => {
  if (!grouped.value) return [{ key: 'all', header: false, label: '', dot: '', n: 0, rows: slice.value }]
  return STATE_ORDER.map((state) => ({
    key: state,
    header: true,
    label: STATE_LABEL[state]!,
    dot: STATE_DOT[state]!,
    rows: slice.value.filter((p) => p.state === state),
  }))
    .filter((g) => g.rows.length)
    .map((g) => ({ ...g, n: g.rows.length }))
})

// ---- selection ----
const selectedIds = computed(() => Object.keys(selected.value).filter((k) => selected.value[k]))
const allOnPage = computed(() => slice.value.length > 0 && slice.value.every((p) => selected.value[p.id]))

function toggleAll() {
  const on = !allOnPage.value
  const next = { ...selected.value }
  for (const p of slice.value) next[p.id] = on
  selected.value = next
}

// ---- bulk actions ----
const busy = ref('')
const notice = ref<{ text: string; severity: 'success' | 'warn' | 'error' | 'info' } | null>(null)
const applyOpen = ref(false)

const selectedPostings = computed(
  () => selectedIds.value.map((id) => postings.value.find((p) => p.id === id)).filter(Boolean) as PostingMeta[],
)

/** One call per selected posting, reporting how many actually landed. */
async function runBulk(key: string, label: string, call: (p: PostingMeta) => Promise<unknown>) {
  busy.value = key
  let ok = 0
  const failed: string[] = []
  for (const p of selectedPostings.value) {
    try {
      await call(p)
      ok++
    } catch {
      failed.push(p.company)
    }
  }
  selected.value = {}
  busy.value = ''
  await refresh()
  notice.value = failed.length
    ? { text: `${label}: ${ok} done, ${failed.length} failed (${failed.slice(0, 3).join(', ')}).`, severity: 'warn' }
    : { text: `${label}: ${ok} done.`, severity: 'success' }
}

const bulkBuild = () => runBulk('build', 'Queued', (p) => $fetch(`/api/postings/${p.id}/pack`, { method: 'POST', body: {} }))

const bulkDismiss = () =>
  runBulk('dismiss', 'Dismissed', (p) =>
    $fetch(`/api/postings/${p.id}/state`, { method: 'POST', body: { state: 'dismissed' } }),
  )

/**
 * The one that writes to Notion, so it is the one that asks first: a row per
 * selected posting, and no undo on this side.
 */
async function bulkApply() {
  applyOpen.value = false
  busy.value = 'applied'
  let ok = 0
  const refused: string[] = []
  for (const p of selectedPostings.value) {
    try {
      const res = await $fetch<PostingApplyResult>(`/api/postings/${p.id}/applied`, { method: 'POST' })
      if (res.notion.ok) ok++
      else refused.push(p.company)
    } catch {
      refused.push(p.company)
    }
  }
  selected.value = {}
  busy.value = ''
  await refresh()
  notice.value = refused.length
    ? {
        text: `${ok} added to Notion; ${refused.length} refused (${refused.slice(0, 3).join(', ')}). They are marked applied here either way.`,
        severity: 'warn',
      }
    : { text: `${ok} added to Notion. They join the funnel within 5 minutes (the stats are cached).`, severity: 'success' }
}

// ---- presentation ----
/** The window push-postings uses when deciding what is still worth sending. */
const STALE = 21

function ageDays(p: PostingMeta): number | null {
  const iso = p.firstSeen || p.createdAt
  if (!iso) return null
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
  return Number.isFinite(d) ? Math.max(0, d) : null
}

const PACK_LABEL: Record<string, string> = {
  none: 'Build pack',
  requested: 'Requested',
  building: 'Building…',
  done: 'Ready',
  failed: 'Failed',
}

const lede = computed(() => {
  const ready = matches.value.filter((p) => p.pack === 'done' && p.state !== 'applied').length
  const evaluated = matches.value.filter((p) => p.hasAnalysis).length
  const fresh = matches.value.filter((p) => p.state === 'new').length
  return {
    strong: ready
      ? `${ready} ${ready === 1 ? 'pack is' : 'packs are'} built and waiting to be sent.`
      : 'Nothing is built and waiting.',
    rest:
      `${fresh} of ${matches.value.length} ${matches.value.length === 1 ? 'posting is' : 'postings are'} still unread; ` +
      `${evaluated} ${evaluated === 1 ? 'carries' : 'carry'} a full evaluation.`,
  }
})

function resetFilters() {
  search.value = ''
  source.value = 'all'
  pickView('all')
}
</script>

<template>
  <div class="postings-page listing">
    <header>
      <div>
        <NuxtLink to="/" class="crumb"><i class="pi pi-arrow-left" /> Pipeline</NuxtLink>
        <h1>Postings<span class="count mono">{{ postings.length }}</span></h1>
      </div>
      <div class="header-tools">
        <PrimeButton
          v-if="notionUrl"
          as="a"
          :href="notionUrl"
          target="_blank"
          rel="noopener"
          label="Open in Notion"
          icon="pi pi-external-link"
          icon-pos="right"
          severity="secondary"
          outlined
          size="small"
        />
        <AddPostingButton />
      </div>
    </header>

    <p v-if="!pending && !error && postings.length" class="lede">
      <span class="lede-strong">{{ lede.strong }}</span> {{ lede.rest }}
    </p>

    <div v-if="pending" class="skel" aria-busy="true" aria-label="Loading postings">
      <div class="skel-panel sk" style="height: 58px; margin-bottom: 14px" />
      <div class="skel-panel sk" style="height: 620px; animation-delay: 120ms" />
    </div>

    <PrimeMessage v-else-if="error" severity="error" :closable="false">
      Couldn't load postings. {{ error.message }}
    </PrimeMessage>
    <PrimeMessage v-else-if="data && !data.enabled" severity="warn" :closable="false">
      Postings are not enabled on this deploy (no POSTINGS KV binding).
    </PrimeMessage>
    <PrimeMessage v-else-if="!postings.length" severity="secondary" :closable="false">
      Nothing yet. The morning scan pushes anything it scores 4.0 or better — or add one by URL.
    </PrimeMessage>

    <template v-else>
      <PrimeMessage v-if="notice" :severity="notice.severity" @close="notice = null">{{ notice.text }}</PrimeMessage>

      <!-- Saved views. The count is the navigation. -->
      <nav class="views" aria-label="Views">
        <button
          v-for="v in views"
          :key="v.key"
          type="button"
          class="view"
          :class="{ on: v.on }"
          :aria-pressed="v.on"
          @click="pickView(v.key)"
        >
          <span class="view-label"><span class="dot" :style="{ background: v.dot }" />{{ v.label }}</span>
          <span class="view-n mono">{{ v.n }}</span>
        </button>
      </nav>

      <section class="listing-panel" aria-label="Posting list">
        <div class="listing-tools">
          <PrimeIconField class="grow">
            <PrimeInputIcon class="pi pi-search" />
            <PrimeInputText v-model="search" placeholder="Search company, position, source…" size="small" autocomplete="off" />
          </PrimeIconField>
          <label class="inline-field">
            <span>Source</span>
            <PrimeSelect v-model="source" :options="sourceOpts" option-label="label" option-value="value" size="small" />
          </label>
          <PrimeButton
            label="Group by state"
            icon="pi pi-list"
            size="small"
            :severity="grouped ? 'primary' : 'secondary'"
            :outlined="!grouped"
            :aria-pressed="grouped"
            @click="grouped = !grouped"
          />
          <span class="range mono">{{ rangeText }}</span>
        </div>

        <!-- Only present when something is selected. -->
        <div v-if="selectedIds.length" class="bulk" role="status">
          <span class="bulk-n mono">{{ selectedIds.length }} selected</span>
          <PrimeButton label="Build packs" icon="pi pi-file-pdf" size="small" severity="secondary" outlined :loading="busy === 'build'" @click="bulkBuild" />
          <PrimeButton label="Mark applied" icon="pi pi-send" size="small" severity="secondary" outlined :loading="busy === 'applied'" @click="applyOpen = true" />
          <PrimeButton label="Dismiss" icon="pi pi-times" size="small" severity="secondary" outlined :loading="busy === 'dismiss'" @click="bulkDismiss" />
          <button type="button" class="linkish clear" @click="selected = {}">Clear</button>
        </div>

        <div class="table-scroll">
          <table class="postings-table">
            <thead>
              <tr>
                <th class="pick">
                  <input type="checkbox" :checked="allOnPage" aria-label="Select all on this page" @change="toggleAll" />
                </th>
                <th
                  v-for="h in HEADS"
                  :key="h.label"
                  :class="[h.right ? 'right' : '', h.key ? 'sortable' : '', h.key === 'company' ? 'col-company' : '']"
                  :aria-sort="sortKey === h.key ? (sortDir > 0 ? 'ascending' : 'descending') : 'none'"
                  @click="h.key && sortBy(h.key)"
                >
                  <span class="th-inner">
                    {{ h.label }}<span v-if="sortKey === h.key" class="arrow">{{ sortDir > 0 ? '↑' : '↓' }}</span>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              <template v-for="g in groups" :key="g.key">
                <tr v-if="g.header" class="group-row">
                  <td colspan="9">
                    <span class="group-label"><span class="dot" :style="{ background: g.dot }" />{{ g.label }}<span class="n mono">{{ g.n }}</span></span>
                  </td>
                </tr>
                <tr v-for="p in g.rows" :key="p.id" :class="{ picked: selected[p.id] }">
                  <td class="pick">
                    <input
                      type="checkbox"
                      :checked="!!selected[p.id]"
                      :aria-label="`Select ${p.company}`"
                      @change="selected = { ...selected, [p.id]: !selected[p.id] }"
                    />
                  </td>
                  <td class="right">
                    <span class="score mono" :style="{ color: scoreColor(p.score) }">
                      {{ p.score === null ? '—' : p.score.toFixed(1) }}
                    </span>
                  </td>
                  <td class="col-company">
                    <NuxtLink class="tbl-link" :to="`/postings/${p.id}`">{{ p.company }}</NuxtLink>
                    <div v-if="p.role" class="tbl-sub">{{ p.role }}</div>
                  </td>
                  <td>
                    <span class="status-pill" :class="{ closed: p.state === 'dismissed' }">
                      <span class="dot" :style="{ background: STATE_DOT[p.state] }" />{{ STATE_LABEL[p.state] }}
                    </span>
                  </td>
                  <td class="mono clip">{{ p.comp || '—' }}</td>
                  <td class="muted clip">{{ p.geo || p.location || '—' }}</td>
                  <td class="muted clip src">{{ p.source || '—' }}</td>
                  <td class="right">
                    <ClientOnly>
                      <span class="age-cell mono">
                        <span class="age-track" aria-hidden="true">
                          <span
                            class="age-fill"
                            :style="{
                              width: Math.min(100, ((ageDays(p) ?? 0) / STALE) * 100) + '%',
                              background: (ageDays(p) ?? 0) > STALE ? 'var(--stone)' : 'var(--amber)',
                            }"
                          />
                        </span>
                        <span :class="(ageDays(p) ?? 0) > STALE ? 'muted' : ''">{{ ageDays(p) === null ? '—' : ageDays(p) + 'd' }}</span>
                      </span>
                    </ClientOnly>
                  </td>
                  <td class="right">
                    <NuxtLink class="pack-chip" :class="'is-' + p.pack" :to="`/postings/${p.id}`">
                      <i class="pi pi-file-pdf" />{{ PACK_LABEL[p.pack] }}
                    </NuxtLink>
                  </td>
                </tr>
              </template>
              <tr v-if="!sorted.length">
                <td colspan="9" class="tbl-empty">
                  <p class="empty-title">Nothing matches this view.</p>
                  <p class="muted small">
                    {{ search.trim() ? `No posting mentions “${search.trim()}”.` : 'This view has no postings under the current source filter.' }}
                  </p>
                  <PrimeButton label="Reset filters" size="small" severity="secondary" outlined @click="resetFilters" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="listing-foot">
          <label class="inline-field">
            <span>Rows</span>
            <PrimeSelect v-model="per" :options="[12, 25, 50]" size="small" @change="page = 0" />
          </label>
          <div class="pager">
            <PrimeButton icon="pi pi-angle-left" size="small" text severity="secondary" aria-label="Previous page" :disabled="pg === 0" @click="page = Math.max(0, pg - 1)" />
            <button v-for="i in pageButtons" :key="i" type="button" class="page-btn" :class="{ on: i === pg }" @click="page = i">
              {{ i + 1 }}
            </button>
            <PrimeButton icon="pi pi-angle-right" size="small" text severity="secondary" aria-label="Next page" :disabled="pg >= pageCount - 1" @click="page = Math.min(pageCount - 1, pg + 1)" />
          </div>
        </div>
      </section>

      <!-- Bulk apply writes a Notion row per posting, so it asks first. -->
      <PrimeDialog
        v-model:visible="applyOpen"
        modal
        header="Mark these applied?"
        :style="{ width: 'min(480px, calc(100vw - 32px))' }"
      >
        <div class="delete-dialog">
          <p>
            Creates <b>{{ selectedIds.length }}</b> {{ selectedIds.length === 1 ? 'row' : 'rows' }} in the Notion
            applications database, one per posting, and each joins the funnel within 5 minutes.
          </p>
          <ul class="apply-list">
            <li v-for="p in selectedPostings.slice(0, 6)" :key="p.id">
              {{ p.company }}<span v-if="p.role" class="muted"> · {{ p.role }}</span>
            </li>
            <li v-if="selectedPostings.length > 6" class="muted">…and {{ selectedPostings.length - 6 }} more</li>
          </ul>
          <p class="muted">There is no undo on this side — a row created by mistake has to be deleted in Notion.</p>
        </div>
        <template #footer>
          <PrimeButton label="Cancel" severity="secondary" text size="small" @click="applyOpen = false" />
          <PrimeButton label="Mark applied" icon="pi pi-send" size="small" :loading="busy === 'applied'" @click="bulkApply" />
        </template>
      </PrimeDialog>

      <!-- Client-only: toLocaleString() is locale/timezone-dependent, so SSR
           and the client disagree (hydration text mismatch). -->
      <ClientOnly>
        <footer class="mono">{{ footer }}</footer>
      </ClientOnly>
    </template>
  </div>
</template>

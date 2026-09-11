<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import type { PackMeta, PacksResponse, Stats } from '../../../shared/types'

useHead({ title: 'Interview packs' })

// useFetch directly rather than through usePacks(): this page needs rows
// server-side, and awaiting the composable does not work — Nuxt's asyncData
// `then` resolves to its own object, so the destructured helpers come back
// undefined. Same trap as pages/postings/index.vue.
const { data, pending, error, refresh } = await useFetch<PacksResponse>('/api/packs', { key: 'packs' })
const packs = computed(() => data.value?.packs ?? [])

// The gap list needs the tracker: which conversations are live right now.
const { data: stats } = await useStats()

const LABEL: Record<string, string> = {
  requested: 'Requested',
  building: 'Building…',
  done: 'Ready',
  failed: 'Failed',
}
const ICON: Record<string, string> = {
  requested: 'pi pi-clock',
  building: 'pi pi-spin pi-spinner',
  done: 'pi pi-check-circle',
  failed: 'pi pi-exclamation-triangle',
}

// ---- filtering ----
const search = ref('')
const view = ref('all')

const all = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return packs.value
  return packs.value.filter((p) => `${p.company} ${p.position} ${p.note}`.toLowerCase().includes(q))
})

const VIEWS: [string, string, string][] = [
  ['all', 'All', 'var(--stone)'],
  ['done', 'Ready', 'var(--green)'],
  ['building', 'Building', 'var(--blue)'],
  ['requested', 'Queued', 'var(--amber)'],
  ['failed', 'Failed', 'var(--danger)'],
]

const views = computed(() =>
  VIEWS.map(([key, label, dot]) => ({
    key,
    label,
    dot,
    n: all.value.filter((p) => key === 'all' || p.status === key).length,
    on: view.value === key,
  })),
)

/**
 * Problems first: a failed build and a stuck one are the rows that need him.
 * A ready pack is the least urgent thing on the page — it is already done.
 */
const ORDER: Record<string, number> = { failed: 0, building: 1, requested: 2, done: 3 }

const list = computed(() =>
  all.value
    .filter((p) => view.value === 'all' || p.status === view.value)
    .slice()
    .sort((a, b) => (ORDER[a.status]! - ORDER[b.status]!) || b.updatedAt.localeCompare(a.updatedAt)),
)

// ---- the gap: live conversations with no pack ----
const LIVE_BUCKETS = ['pending', 'interviewed', 'progressing']

const gaps = computed(() => {
  const have = new Set(packs.value.map((p) => p.jobId))
  return (stats.value?.jobs ?? [])
    .filter((j) => LIVE_BUCKETS.includes(j.bucket) && !have.has(j.id))
    .map((j) => ({
      ...j,
      meta: `${j.stage || 'no stage'} · ${j.ageDays ?? 0}d`,
    }))
})

// ---- actions ----
const busy = ref('')
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined

/**
 * A toast rather than an inline message: every action here is a confirmation
 * of something that happened elsewhere (the Mac picked it up), and an inline
 * banner would push the list he is working down the page each time.
 */
function say(text: string) {
  clearTimeout(toastTimer)
  toast.value = text
  toastTimer = setTimeout(() => (toast.value = ''), 5000)
}
onBeforeUnmount(() => clearTimeout(toastTimer))

async function rebuild(p: PackMeta) {
  busy.value = p.jobId
  try {
    await $fetch(`/api/packs/${p.jobId}/request`, {
      method: 'POST',
      body: { company: p.company, position: p.position, note: p.note },
    })
    await refresh()
    say(`Queued a rebuild of the ${p.company} pack. The Mac picks it up from Notion.`)
  } catch (err: any) {
    say(`Couldn't queue ${p.company}: ${err?.data?.statusMessage || err?.message || 'failed'}`)
  } finally {
    busy.value = ''
  }
}

async function buildFor(job: { id: string; company: string; position: string }) {
  busy.value = job.id
  try {
    await $fetch(`/api/packs/${job.id}/request`, {
      method: 'POST',
      body: { company: job.company, position: job.position },
    })
    await refresh()
    say(`Queued a pack for ${job.company}.`)
  } catch (err: any) {
    say(`Couldn't queue ${job.company}: ${err?.data?.statusMessage || err?.message || 'failed'}`)
  } finally {
    busy.value = ''
  }
}

const confirmPack = ref<PackMeta | null>(null)

const confirmDetail = computed(() => {
  const p = confirmPack.value
  if (!p) return ''
  if (p.status !== 'done') return 'nothing has been built yet'
  const files = p.exports.length
  return `${p.answers} cards, ${p.beats} beats and ${files} exported file${files === 1 ? '' : 's'}`
})

async function doDelete() {
  const p = confirmPack.value
  if (!p) return
  confirmPack.value = null
  try {
    await $fetch(`/api/packs/${p.jobId}`, { method: 'DELETE' })
    await refresh()
    say(`Deleted the ${p.company} pack.`)
  } catch (err: any) {
    say(`Couldn't delete ${p.company}: ${err?.data?.statusMessage || err?.message || 'failed'}`)
  }
}

/** Packs are built from a live conversation, so that list is the entry point. */
function startNew() {
  if (!gaps.value.length) {
    say('Every live conversation already has a pack.')
    return
  }
  document.getElementById('pack-gaps')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ---- presentation ----
function when(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })
}

function ago(iso: string): string {
  const h = (Date.now() - Date.parse(iso)) / 3_600_000
  if (!Number.isFinite(h)) return ''
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`
  if (h < 48) return `${Math.round(h)}h ago`
  return `${Math.round(h / 24)}d ago`
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

function counts(p: PackMeta): string {
  if (p.status === 'failed') return 'build aborted'
  if (p.status !== 'done') return 'nothing built yet'
  return (
    `${plural(p.answers, 'card')} · ${plural(p.beats, 'beat')}` +
    (p.exports.length ? ` · ${plural(p.exports.length, 'export')}` : '')
  )
}

const lede = computed(() => {
  const done = all.value.filter((p) => p.status === 'done').length
  const failed = all.value.filter((p) => p.status === 'failed').length
  const live = all.value.filter((p) => p.status === 'requested' || p.status === 'building').length
  const g = gaps.value.length
  return {
    strong: failed
      ? `${failed} build${failed === 1 ? '' : 's'} failed.`
      : live
        ? `${live} pack${live === 1 ? ' is' : 's are'} still building.`
        : `${done} pack${done === 1 ? '' : 's'} ready.`,
    rest:
      `${done} ready to read${live ? `, ${live} in the queue` : ''}` +
      (g ? `. ${g} live conversation${g === 1 ? ' has' : 's have'} no pack yet` : '') +
      '.',
  }
})
</script>

<template>
  <div class="packs-page listing">
    <header>
      <div>
        <NuxtLink to="/" class="crumb"><i class="pi pi-arrow-left" /> Pipeline</NuxtLink>
        <h1>Interview packs<span class="count mono">{{ packs.length }}</span></h1>
      </div>
      <PrimeButton label="Build a pack" icon="pi pi-plus" size="small" @click="startNew" />
    </header>

    <p v-if="!pending && !error && packs.length" class="lede">
      <span class="lede-strong">{{ lede.strong }}</span> {{ lede.rest }}
    </p>

    <div v-if="pending" class="skel" aria-busy="true" aria-label="Loading packs">
      <div class="skel-panel sk" style="height: 52px; margin-bottom: 14px" />
      <div class="skel-panel sk" style="height: 320px; animation-delay: 120ms" />
    </div>

    <PrimeMessage v-else-if="error" severity="error" :closable="false">
      Couldn't load packs. {{ error.message }}
    </PrimeMessage>
    <PrimeMessage v-else-if="data && !data.enabled" severity="warn" :closable="false">
      Packs are not enabled on this deploy (no PACKS KV binding).
    </PrimeMessage>

    <template v-else>
      <nav v-if="packs.length" class="views" aria-label="Status filter">
        <button
          v-for="v in views"
          :key="v.key"
          type="button"
          class="view"
          :class="{ on: v.on }"
          :aria-pressed="v.on"
          @click="view = v.key"
        >
          <span class="view-label"><span class="dot" :style="{ background: v.dot }" />{{ v.label }}</span>
          <span class="view-n mono">{{ v.n }}</span>
        </button>
      </nav>

      <section v-if="packs.length" class="listing-panel packs-panel" aria-label="Packs">
        <div class="listing-tools">
          <PrimeIconField class="grow">
            <PrimeInputIcon class="pi pi-search" />
            <PrimeInputText v-model="search" placeholder="Search company, position, note…" size="small" autocomplete="off" />
          </PrimeIconField>
          <span class="range mono">{{ list.length }} of {{ all.length }}</span>
        </div>

        <div class="pack-rows">
          <template v-for="p in list" :key="p.jobId">
            <div class="pack-row">
              <NuxtLink class="pack-main" :to="`/packs/${p.jobId}`">
                <span class="who">
                  <span class="co">{{ p.company }}</span>
                  <span class="role">{{ p.position || '—' }}</span>
                </span>
                <span class="status-pill" :class="p.status">
                  <i :class="ICON[p.status]" />{{ LABEL[p.status] }}
                </span>
                <span class="counts mono">{{ counts(p) }}</span>
                <ClientOnly>
                  <span class="stamp mono">{{ p.status === 'done' ? `built ${when(p.builtAt)}` : ago(p.updatedAt) }}</span>
                </ClientOnly>
              </NuxtLink>
              <span class="pack-acts">
                <button
                  type="button"
                  class="icon-btn"
                  :aria-label="`Rebuild the ${p.company} pack`"
                  :title="`Rebuild the ${p.company} pack`"
                  :disabled="busy === p.jobId"
                  @click="rebuild(p)"
                >
                  <i :class="busy === p.jobId ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'" />
                </button>
                <button
                  type="button"
                  class="icon-btn danger"
                  :aria-label="`Delete the ${p.company} pack`"
                  :title="`Delete the ${p.company} pack`"
                  @click="confirmPack = p"
                >
                  <i class="pi pi-trash" />
                </button>
              </span>
            </div>
            <p v-if="p.error" class="pack-row-error mono">{{ p.error }}</p>
          </template>

          <div v-if="!list.length" class="tbl-empty">
            <p class="empty-title">No packs in this view.</p>
            <p class="muted small">
              {{ search.trim() ? `No pack mentions “${search.trim()}”.` : 'Packs appear here once you queue one from a conversation.' }}
            </p>
            <PrimeButton label="Show all" size="small" severity="secondary" outlined @click="view = 'all'; search = ''" />
          </div>
        </div>
      </section>

      <PrimeMessage v-if="!packs.length" severity="secondary" :closable="false">
        No packs yet. Queue one from a live conversation below, or from a job in the tracker.
      </PrimeMessage>

      <!-- The reason to be on this page: interviews you would walk into cold. -->
      <section v-if="gaps.length" id="pack-gaps" class="sec gaps" aria-label="Interviews without a pack">
        <div class="gaps-head">
          <h2>In conversation, no pack<span class="n mono">{{ gaps.length }}</span></h2>
          <span class="sec-note">the ones you would walk in cold</span>
        </div>
        <div class="gap-rows">
          <div v-for="j in gaps" :key="j.id" class="gap-row">
            <span class="who">
              <span class="co">{{ j.company }}</span>
              <span class="role">{{ j.position || '—' }}</span>
            </span>
            <span class="gap-meta mono">{{ j.meta }}</span>
            <PrimeButton
              label="Build pack"
              icon="pi pi-plus"
              size="small"
              severity="secondary"
              outlined
              :loading="busy === j.id"
              @click="buildFor(j)"
            />
          </div>
        </div>
      </section>

      <!-- A toast, not an inline banner: these confirm something that happened
           on the Mac, and a banner would shove the list down on every action. -->
      <Transition name="toast">
        <div v-if="toast" class="toast" role="status">
          <i class="pi pi-check-circle" />
          <span>{{ toast }}</span>
          <button type="button" class="toast-x" aria-label="Dismiss" @click="toast = ''"><i class="pi pi-times" /></button>
        </div>
      </Transition>

      <PrimeDialog
        :visible="!!confirmPack"
        modal
        header="Delete this pack?"
        :style="{ width: 'min(440px, calc(100vw - 32px))' }"
        @update:visible="confirmPack = null"
      >
        <div class="delete-dialog">
          <p>Removes the pack for <b>{{ confirmPack?.company }}</b> — {{ confirmDetail }}.</p>
          <p class="muted">
            The Notion row and the application stay as they are. You can rebuild it from the tracker at any time.
          </p>
        </div>
        <template #footer>
          <PrimeButton label="Cancel" severity="secondary" text size="small" @click="confirmPack = null" />
          <PrimeButton label="Delete pack" icon="pi pi-trash" severity="danger" size="small" @click="doDelete" />
        </template>
      </PrimeDialog>
    </template>
  </div>
</template>

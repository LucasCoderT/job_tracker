<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import type { Bucket, BucketKey, Job } from '../../shared/types'
import { reachableStages } from '#shared/pipeline'

const props = defineProps<{
  buckets: Bucket[]
  jobs: Job[]
  total: number
  staleDays: number
}>()

// Pack state per row (one shared request; see usePacks).
const { byJob: packs } = usePacks()

// ---- Rejected / moved on a round ----
//
// One menu for the whole tracker, re-anchored to whichever card's button was
// pressed: a PrimeMenu per card would be ~180 overlays on the All filter.
const { busyId, toast, reject, advance, dismiss } = useJobStatus()
const menu = ref<any>(null)
const menuJob = ref<Job | null>(null)
const menuOpen = ref(false)

const menuItems = computed(() => {
  const job = menuJob.value
  if (!job) return []
  const interviewing = job.bucket === 'interviewed' || job.bucket === 'progressing'
  const rungs = reachableStages(job.stage, interviewing, job.bucket === 'offerAccepted')
  const groups: any[] = []
  if (rungs.length) {
    groups.push({
      label: 'Progressed to',
      items: rungs.map((stage) => ({
        label: stage,
        icon: stage === 'Offer' ? 'pi pi-star' : 'pi pi-arrow-right',
        command: () => advance(job, stage),
      })),
    })
  }
  if (job.bucket !== 'rejected') {
    groups.push({
      label: 'Closed',
      items: [{ label: 'Rejected', icon: 'pi pi-times', class: 'is-reject', command: () => reject(job) }],
    })
  }
  return groups
})

function openStatusMenu(event: MouseEvent, job: Job) {
  if (menuOpen.value && menuJob.value?.id === job.id) return menu.value?.hide()
  // Captured now: by the time nextTick runs the event has finished dispatching
  // and currentTarget is null, which would anchor the menu to nothing.
  const target = event.currentTarget as HTMLElement
  menu.value?.hide()
  menuJob.value = job
  nextTick(() => menu.value?.show(event, target))
}

const view = ref<'board' | 'table'>('board')
const viewOptions = [
  { label: 'Board', value: 'board' },
  { label: 'Table', value: 'table' },
]

/**
 * Status filters. 129 rows across 8 columns means the two columns he can
 * still act on are off the side of a board dominated by dead ones — the
 * default is "In conversation" for that reason, not "All".
 *
 * The choice is per-device and inconsequential if lost, so localStorage is
 * the right home for it. Read in onMounted, never during setup: touching it
 * on the server has no value there and reading it during hydration would
 * make the client's first render disagree with the SSR markup.
 */
const GROUPS: Record<string, BucketKey[] | null> = {
  all: null,
  talking: ['pending', 'interviewed', 'progressing'],
  live: ['awaiting', 'pending', 'interviewed', 'progressing'],
  closed: ['rejected', 'offerDeclined', 'offerAccepted'],
  stale: ['noAnswer'],
}
const FILTER_LABELS: [string, string][] = [
  ['all', 'All'],
  ['talking', 'In conversation'],
  ['live', 'Live'],
  ['closed', 'Closed'],
  ['stale', 'No answer'],
]
const STORE_KEY = 'jobPipeline.trackerFilter'
const filter = ref('talking')

onMounted(() => {
  try {
    const saved = localStorage.getItem(STORE_KEY)
    if (saved && saved in GROUPS) filter.value = saved
  } catch {
    /* private mode, blocked storage — the default is fine */
  }
})

function pick(key: string) {
  filter.value = key
  try {
    localStorage.setItem(STORE_KEY, key)
  } catch {
    /* nothing to do; the filter still works for this visit */
  }
}

// One search box drives both views.
const search = ref('')
const searching = computed(() => search.value.trim().length > 0)
const found = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.jobs
  return props.jobs.filter((j) =>
    (j.company + ' ' + j.position + ' ' + (j.source || '')).toLowerCase().includes(q),
  )
})

const inGroup = (bucket: BucketKey, key: string) => {
  const g = GROUPS[key]
  return !g || g.includes(bucket)
}

const filtered = computed(() => found.value.filter((j) => inGroup(j.bucket, filter.value)))
const shownBuckets = computed(() => props.buckets.filter((b) => inGroup(b.key, filter.value)))

const filters = computed(() =>
  FILTER_LABELS.map(([key, label]) => ({
    key,
    label,
    n: found.value.filter((j) => inGroup(j.bucket, key)).length,
    on: filter.value === key,
  })),
)
</script>

<template>
  <PrimeCard id="tracker" class="sec" aria-label="Job tracker">
    <template #content>
      <div class="tracker-head">
        <div class="tracker-heading">
          <h2 class="tracker-title">Job Tracker</h2>
          <span class="total mono">{{ total }} applications</span>
        </div>
        <div class="tracker-tools">
          <div class="filter-group" role="group" aria-label="Filter by status">
            <button
              v-for="f in filters"
              :key="f.key"
              type="button"
              class="filter-btn"
              :class="{ on: f.on }"
              :aria-pressed="f.on"
              @click="pick(f.key)"
            >
              {{ f.label }}<span class="n mono">{{ f.n }}</span>
            </button>
          </div>
          <PrimeSelectButton
            v-model="view"
            :options="viewOptions"
            option-label="label"
            option-value="value"
            :allow-empty="false"
            size="small"
            aria-label="Toggle board or table view"
          />
          <PrimeIconField>
            <PrimeInputIcon class="pi pi-search" />
            <PrimeInputText
              v-model="search"
              placeholder="Search company, position, source…"
              size="small"
              autocomplete="off"
            />
          </PrimeIconField>
        </div>
      </div>

      <TrackerBoard
        v-if="view === 'board'"
        :buckets="shownBuckets"
        :jobs="filtered"
        :searching="searching"
        :packs="packs"
        :busy-id="busyId"
        @status="openStatusMenu"
      />
      <ApplicationsTable
        v-else
        :jobs="filtered"
        :packs="packs"
        :buckets="buckets"
        :stale-days="staleDays"
        :busy-id="busyId"
        @status="openStatusMenu"
      />

      <PrimeMenu
        ref="menu"
        :model="menuItems"
        popup
        class="status-menu"
        @show="menuOpen = true"
        @hide="menuOpen = false"
      />

      <!-- A rejected job leaves the default "In conversation" filter the moment
           it is marked, so the toast is what says where it went — and Undo is
           the safety net for a mis-tap on a phone, instead of a confirm step
           on every change. -->
      <Transition name="toast">
        <div v-if="toast" class="toast" :class="{ 'is-error': toast.error }" role="status">
          <i :class="toast.error ? 'pi pi-exclamation-triangle' : 'pi pi-check-circle'" />
          <span>{{ toast.text }}</span>
          <button v-if="toast.undo" type="button" class="toast-undo" @click="toast.undo()">Undo</button>
          <button type="button" class="toast-x" aria-label="Dismiss" @click="dismiss"><i class="pi pi-times" /></button>
        </div>
      </Transition>
    </template>
  </PrimeCard>
</template>

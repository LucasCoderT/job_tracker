<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Bucket, Job } from '../../shared/types'

const props = defineProps<{
  buckets: Bucket[]
  jobs: Job[]
  total: number
}>()

// Pack state per row (one shared request; see usePacks).
const { byJob: packs } = usePacks()

const view = ref<'board' | 'table'>('board')
const viewOptions = [
  { label: 'Board', value: 'board' },
  { label: 'Table', value: 'table' },
]

// One search box drives both views.
const search = ref('')
const searching = computed(() => search.value.trim().length > 0)
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.jobs
  return props.jobs.filter((j) =>
    (j.company + ' ' + j.position + ' ' + (j.source || '')).toLowerCase().includes(q),
  )
})
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

      <TrackerBoard v-if="view === 'board'" :buckets="buckets" :jobs="filtered" :searching="searching" :packs="packs" />
      <ApplicationsTable v-else :jobs="filtered" :packs="packs" />
    </template>
  </PrimeCard>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Bucket, Job, PackMeta } from '../../shared/types'

// Board view. Search + the section header now live in TrackerSection, which
// passes an already-filtered `jobs` set and whether a search is active.
const props = defineProps<{
  buckets: Bucket[]
  jobs: Job[]
  searching: boolean
  packs: Map<string, PackMeta>
}>()

function dotColor(color: string): string {
  return `var(--${color})`
}

function whenText(job: Job): string {
  if (!job.date || job.ageDays == null) return ''
  if (job.ageDays <= 0) return 'today'
  if (job.ageDays === 1) return '1 day ago'
  return job.ageDays + ' days ago'
}

const columns = computed(() =>
  props.buckets.map((col) => {
    const jobs = props.jobs.filter((j) => j.bucket === col.key)
    return {
      ...col,
      jobs,
      hadAny: col.count > 0,
      // col.count is the full (unfiltered) bucket size; jobs.length is filtered.
      badge: props.searching ? `${jobs.length}/${col.count}` : String(col.count),
    }
  }),
)
</script>

<template>
  <div class="board">
    <div v-for="col in columns" :key="col.key" class="col">
      <div class="col-head">
        <span class="dot" :style="{ background: dotColor(col.color) }" />
        {{ col.label }}
        <span class="n mono">{{ col.badge }}</span>
      </div>
      <div class="cards">
        <div v-if="!col.hadAny" class="empty-col">No jobs yet</div>
        <!-- The card is a div: the Notion link and the pack chip are both
             links, and an anchor cannot nest an anchor. -->
        <div v-for="(job, i) in col.jobs" :key="i" class="card">
          <a class="card-main" :href="job.url || '#'" target="_blank" rel="noopener">
            <p class="co">{{ job.company }}</p>
            <p v-if="job.position" class="role">{{ job.position }}</p>
            <p v-if="whenText(job)" class="when mono">{{ whenText(job) }}</p>
          </a>
          <PackChip :job="job" :pack="packs.get(job.id)" />
        </div>
      </div>
    </div>
  </div>
</template>

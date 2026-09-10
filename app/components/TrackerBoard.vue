<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Bucket, Job, PackMeta } from '../../shared/types'

// Board view. Search, the status filter and the section header live in
// TrackerSection, which passes an already-filtered `jobs` set.
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

/**
 * A column caps at 460px and scrolls, which silently hid whatever was below
 * the fold (DESIGN.md §7.9). Each column now says how much is down there and
 * fades the last card, and stops saying it once you reach the end.
 */
const CARD_H = 92
const COL_VIEWPORT = 460 - 50
const scrolled = ref<Record<string, { top: number; atEnd: boolean }>>({})

function onScroll(key: string, e: Event) {
  const el = e.currentTarget as HTMLElement
  scrolled.value = {
    ...scrolled.value,
    [key]: { top: el.scrollTop, atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 4 },
  }
}

const columns = computed(() =>
  props.buckets.map((col) => {
    const jobs = props.jobs.filter((j) => j.bucket === col.key)
    const sc = scrolled.value[col.key] ?? { top: 0, atEnd: false }
    const hidden = Math.max(0, jobs.length - Math.floor((COL_VIEWPORT + sc.top) / CARD_H))
    return {
      ...col,
      jobs,
      hadAny: col.count > 0,
      // col.count is the full (unfiltered) bucket size; jobs.length is filtered.
      badge: props.searching ? `${jobs.length}/${col.count}` : String(col.count),
      more: hidden > 0 && !sc.atEnd,
      moreN: hidden,
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
      <div class="cards" :class="{ 'has-more': col.more }" @scroll="onScroll(col.key, $event)">
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
      <div v-if="col.more" class="col-more" aria-hidden="true">
        <span class="mono">{{ col.moreN }} more ↓</span>
      </div>
    </div>
  </div>
</template>

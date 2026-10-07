<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Bucket, Job, PackMeta, PostingMeta } from '../../shared/types'
import { canChangeStatus } from '#shared/pipeline'

// Board view. Search, the status filter and the section header live in
// TrackerSection, which passes an already-filtered `jobs` set.
const props = defineProps<{
  buckets: Bucket[]
  jobs: Job[]
  searching: boolean
  packs: Map<string, PackMeta>
  /** Notion page id -> the posting it came from. Partial by nature. */
  postings: Map<string, PostingMeta>
  busyId: string | null
}>()

/**
 * Where a row goes when clicked.
 *
 * The posting brief, when the site knows which posting this application came
 * from — it now carries the Notion link itself, plus the evaluation, the JD,
 * the built files and the questions, so going out to Notion first was a step
 * backwards through the better page.
 *
 * Only a linked posting has a `notionPageId` (set by "Mark applied" here, or by
 * the reconcile job's exact-match rules), so plenty of older rows have none.
 * Those keep the Notion link exactly as before: a row that cannot reach a brief
 * must not lose the link it had.
 */
function linkProps(job: Job) {
  const posting = props.postings.get(job.id)
  if (posting) return { to: `/postings/${posting.id}` }
  return job.url
    ? { to: job.url, external: true, target: '_blank', rel: 'noopener' }
    : { to: '#' }
}

// The status menu lives in TrackerSection; a card only says which job.
const emit = defineEmits<{ status: [event: MouseEvent, job: Job] }>()

// Shown whenever there is a move to offer. An offer he has received can still
// be accepted or declined, which the old bucket test hid.
const movable = (job: Job) => canChangeStatus(job)

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
        <!-- Keyed by id, not index: cards now move between columns, and an
             index key would hand one job's DOM (and its busy spinner) to
             whichever card slid into its slot. -->
        <div v-for="job in col.jobs" :key="job.id" class="card">
          <button
            v-if="movable(job)"
            type="button"
            class="icon-btn job-status-btn"
            :aria-label="`Change status for ${job.company}`"
            aria-haspopup="menu"
            :disabled="busyId === job.id"
            @click.stop="emit('status', $event, job)"
          >
            <i :class="busyId === job.id ? 'pi pi-spin pi-spinner' : 'pi pi-ellipsis-v'" />
          </button>
          <NuxtLink class="card-main" v-bind="linkProps(job)">
            <p class="co">{{ job.company }}</p>
            <p v-if="job.position" class="role">{{ job.position }}</p>
            <p v-if="whenText(job)" class="when mono">{{ whenText(job) }}</p>
          </NuxtLink>
          <PackChip :job="job" :pack="packs.get(job.id)" />
        </div>
      </div>
      <div v-if="col.more" class="col-more" aria-hidden="true">
        <span class="mono">{{ col.moreN }} more ↓</span>
      </div>
    </div>
  </div>
</template>

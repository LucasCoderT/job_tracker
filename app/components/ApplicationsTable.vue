<script setup lang="ts">
import { computed } from 'vue'
import type { Bucket, Job, PackMeta, PostingMeta } from '../../shared/types'
import { canChangeStatus } from '#shared/pipeline'

const props = defineProps<{
  jobs: Job[]
  packs: Map<string, PackMeta>
  /** Notion page id -> the posting it came from. Partial by nature. */
  postings: Map<string, PostingMeta>
  buckets: Bucket[]
  staleDays: number
  busyId: string | null
}>()
const emit = defineEmits<{ status: [event: MouseEvent, job: Job] }>()

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


const BUCKET_LABEL: Record<string, string> = {
  awaiting: 'Awaiting',
  pending: 'Pending',
  interviewed: 'Interviewed',
  progressing: 'Progressing',
  offerAccepted: 'Offer',
  offerDeclined: 'Declined',
  rejected: 'Rejected',
  noAnswer: 'No answer',
}

/** The board's own dot colour, so a row reads as the column it came from. */
const dotFor = computed(() => {
  const by: Record<string, string> = {}
  for (const b of props.buckets) by[b.key] = `var(--${b.color})`
  return by
})

const CLOSED = ['rejected', 'offerDeclined', 'noAnswer']

/**
 * Age as a bar against the no-reply cutoff, not a bare number: "23d" means
 * nothing until you know the window is 30 days, and the bar makes a row
 * about to go stale obvious at a glance.
 */
const rows = computed(() =>
  props.jobs.map((j) => {
    const age = j.ageDays ?? 0
    const past = age > props.staleDays
    return {
      ...j,
      statusLabel: BUCKET_LABEL[j.bucket] ?? j.bucket,
      dot: dotFor.value[j.bucket] ?? 'var(--stone)',
      closed: CLOSED.includes(j.bucket),
      ageText: j.ageDays == null ? '—' : age + 'd',
      ageW: Math.min(100, (age / props.staleDays) * 100),
      past,
    }
  }),
)
</script>

<template>
  <div class="table-wrap">
    <PrimeDataTable
      :value="rows"
      data-key="id"
      class="tracker-table"
      paginator
      :rows="12"
      :rows-per-page-options="[12, 25, 50]"
      removable-sort
      sort-field="ageDays"
      :sort-order="1"
      striped-rows
      size="small"
      current-page-report-template="{first}–{last} of {totalRecords}"
      paginator-template="CurrentPageReport PrevPageLink PageLinks NextPageLink RowsPerPageDropdown"
    >
      <template #empty><div class="tbl-empty">Nothing matches.</div></template>

      <PrimeColumn field="company" header="Company" sortable>
        <template #body="{ data }">
          <NuxtLink v-if="data.url || postings.get(data.id)" class="tbl-link" v-bind="linkProps(data)">{{ data.company }}</NuxtLink>
          <span v-else class="tbl-link">{{ data.company }}</span>
          <div v-if="data.position" class="tbl-sub">{{ data.position }}</div>
        </template>
      </PrimeColumn>

      <PrimeColumn field="bucket" header="Status" sortable>
        <template #body="{ data }">
          <span class="status-pill" :class="{ closed: data.closed }">
            <span class="dot" :style="{ background: data.dot }" />{{ data.statusLabel }}
          </span>
        </template>
      </PrimeColumn>

      <PrimeColumn field="stage" header="Stage" sortable>
        <template #body="{ data }">
          <span :class="data.stage ? '' : 'faint'">{{ data.stage || '—' }}</span>
        </template>
      </PrimeColumn>

      <PrimeColumn field="source" header="Source" sortable>
        <template #body="{ data }"><span class="muted">{{ data.source || '—' }}</span></template>
      </PrimeColumn>

      <PrimeColumn field="salary" header="Salary" sortable class="col-right">
        <template #body="{ data }">
          <span class="mono" :class="data.salary ? '' : 'faint'">{{ money(data.salary) }}</span>
        </template>
      </PrimeColumn>

      <PrimeColumn field="nextAction" header="Next" sortable>
        <template #body="{ data }">
          <span v-if="data.nextAction" class="next-flag"><i class="pi pi-flag" />{{ data.nextAction }}</span>
          <span v-else class="faint">—</span>
        </template>
      </PrimeColumn>

      <PrimeColumn field="ageDays" header="Age" sortable class="col-right">
        <template #body="{ data }">
          <span class="age-cell mono">
            <span class="age-track" aria-hidden="true">
              <span class="age-fill" :style="{ width: data.ageW + '%', background: data.past ? 'var(--stone)' : 'var(--amber)' }" />
            </span>
            <span :class="data.past ? 'muted' : ''">{{ data.ageText }}</span>
          </span>
        </template>
      </PrimeColumn>

      <PrimeColumn header="Pack" class="col-right">
        <template #body="{ data }"><PackChip :job="data" :pack="packs.get(data.id)" /></template>
      </PrimeColumn>

      <PrimeColumn class="col-right col-status-action">
        <template #body="{ data }">
          <button
            v-if="canChangeStatus(data)"
            type="button"
            class="icon-btn status-btn"
            :aria-label="`Change status for ${data.company}`"
            aria-haspopup="menu"
            :disabled="busyId === data.id"
            @click.stop="emit('status', $event, data)"
          >
            <i :class="busyId === data.id ? 'pi pi-spin pi-spinner' : 'pi pi-ellipsis-v'" />
          </button>
        </template>
      </PrimeColumn>
    </PrimeDataTable>
  </div>
</template>

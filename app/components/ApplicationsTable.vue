<script setup lang="ts">
import { computed } from 'vue'
import type { Bucket, Job, PackMeta } from '../../shared/types'

const props = defineProps<{
  jobs: Job[]
  packs: Map<string, PackMeta>
  buckets: Bucket[]
  staleDays: number
}>()

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
          <a v-if="data.url" class="tbl-link" :href="data.url" target="_blank" rel="noopener">{{ data.company }}</a>
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
    </PrimeDataTable>
  </div>
</template>

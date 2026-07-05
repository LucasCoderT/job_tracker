<script setup lang="ts">
import type { Job } from '../../shared/types'

// Table view — first real PrimeVue surface in the dashboard. Search is handled
// by the parent (TrackerSection); this just displays, sorts, and paginates the
// already-filtered rows. money() is auto-imported from app/utils/format.ts.
defineProps<{ jobs: Job[] }>()

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

function severity(bucket: string): string {
  if (bucket === 'offerAccepted') return 'success'
  if (bucket === 'rejected' || bucket === 'noAnswer' || bucket === 'offerDeclined') return 'danger'
  if (bucket === 'progressing' || bucket === 'interviewed') return 'info'
  if (bucket === 'awaiting' || bucket === 'pending') return 'warn'
  return 'secondary'
}
</script>

<template>
  <div class="table-wrap">
    <PrimeDataTable
      :value="jobs"
      data-key="url"
      paginator
      :rows="12"
      :rows-per-page-options="[12, 25, 50]"
      removable-sort
      sort-field="date"
      :sort-order="-1"
      striped-rows
      size="small"
    >
      <PrimeColumn field="company" header="Company" sortable>
        <template #body="{ data }">
          <a v-if="data.url" class="tbl-link" :href="data.url" target="_blank" rel="noopener">
            {{ data.company }}
          </a>
          <span v-else>{{ data.company }}</span>
        </template>
      </PrimeColumn>
      <PrimeColumn field="position" header="Position" sortable />
      <PrimeColumn field="bucket" header="Status" sortable>
        <template #body="{ data }">
          <PrimeTag :value="BUCKET_LABEL[data.bucket] || data.bucket" :severity="severity(data.bucket)" />
        </template>
      </PrimeColumn>
      <PrimeColumn field="source" header="Source" sortable>
        <template #body="{ data }">{{ data.source || '—' }}</template>
      </PrimeColumn>
      <PrimeColumn field="salary" header="Salary" sortable>
        <template #body="{ data }">{{ data.salary ? money(data.salary) : '—' }}</template>
      </PrimeColumn>
      <PrimeColumn field="nextAction" header="Next" sortable>
        <template #body="{ data }">{{ data.nextAction || '—' }}</template>
      </PrimeColumn>
      <PrimeColumn field="ageDays" header="Age" sortable>
        <template #body="{ data }">{{ data.ageDays != null ? data.ageDays + 'd' : '—' }}</template>
      </PrimeColumn>
    </PrimeDataTable>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { SalaryContext } from '../../shared/types'

const props = defineProps<{ salary: SalaryContext }>()

const groups = computed(() => [
  { label: 'Heard back', g: props.salary.heardBack, color: 'var(--amber)' },
  { label: 'No reply', g: props.salary.silent, color: 'var(--stone)' },
])

// The actual signal: do replies skew higher- or lower-paid?
const deltaNote = computed(() => {
  const h = props.salary.heardBack
  const s = props.salary.silent
  if (!h.n || !s.n) return ''
  const d = h.median - s.median
  if (d === 0) return ' · same median either way'
  return ` · heard-back runs ${money(Math.abs(d))} ${d > 0 ? 'higher' : 'lower'}`
})
</script>

<template>
  <div class="salary">
    <p v-if="!salary.overall.n" class="empty-col">No salary data yet</p>
    <template v-else>
      <div class="sal-grid">
        <PrimeCard v-for="row in groups" :key="row.label" class="sal-card">
          <template #content>
            <p class="lab">{{ row.label }} <span class="n mono">n={{ row.g.n }}</span></p>
            <p class="med mono" :style="{ color: row.color }">{{ money(row.g.median) }}</p>
            <p class="rng mono">{{ money(row.g.min) }}–{{ money(row.g.max) }}</p>
          </template>
        </PrimeCard>
      </div>
      <p class="sal-note">
        Median asking salary · overall {{ money(salary.overall.median) }} (n={{ salary.overall.n }}){{ deltaNote }}
      </p>
    </template>
  </div>
</template>

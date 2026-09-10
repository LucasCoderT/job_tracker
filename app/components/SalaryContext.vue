<script setup lang="ts">
import { computed } from 'vue'
import type { SalaryContext } from '../../shared/types'

const props = defineProps<{ salary: SalaryContext }>()

/**
 * Two medians used to be two big numbers side by side, which invited the
 * reading "heard-back pays $10k more" off a handful of rows. As a range bar
 * on one shared scale the overlap is the first thing you see, which is the
 * honest summary of a small n.
 */
const rows = computed(() => {
  const h = props.salary.heardBack
  const s = props.salary.silent
  const lo = Math.min(h.min || Infinity, s.min || Infinity)
  const hi = Math.max(h.max, s.max)
  const span = hi - lo || 1
  return [
    { label: 'Heard back', g: h, color: 'var(--amber)' },
    { label: 'No reply', g: s, color: 'var(--stone)' },
  ]
    .filter((r) => r.g.n > 0)
    .map((r) => ({
      label: r.label,
      color: r.color,
      n: r.g.n,
      median: money(r.g.median),
      range: `${money(r.g.min)}–${money(r.g.max)}`,
      minW: ((r.g.min - lo) / span) * 100,
      spanW: ((r.g.max - r.g.min) / span) * 100,
      medW: ((r.g.median - lo) / span) * 100,
    }))
})

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
      <div v-for="r in rows" :key="r.label" class="src-row">
        <span class="dom">{{ r.label }} <span class="n mono">n={{ r.n }}</span></span>
        <span class="sal-scale">
          <span class="sal-span" :style="{ background: r.color, left: r.minW + '%', width: r.spanW + '%' }" />
          <span class="sal-med" :style="{ background: r.color, left: r.medW + '%' }" />
        </span>
        <span class="rate mono"><b :style="{ color: r.color }">{{ r.median }}</b> {{ r.range }}</span>
      </div>
      <p class="sal-note">
        Median asking salary · overall {{ money(salary.overall.median) }} (n={{ salary.overall.n }}){{ deltaNote }}
      </p>
    </template>
  </div>
</template>

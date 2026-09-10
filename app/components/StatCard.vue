<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  name: string
  sub: string
  ratio: number
  color: string
  /** 30 days of this metric, oldest first. Empty until history loads. */
  series?: number[]
}>()

/**
 * Was a donut. A donut cannot express a 2% ratio — three of them read as
 * three identical rings, and StatCard carried an arc floor to force a
 * visible tick, which is a mark apologising for itself (DESIGN.md §7.3).
 *
 * A bar on a shared 0–100 scale is honest at any value, and the sparkline
 * turns a static ratio into the thing he actually wants to know: whether it
 * is moving (§7.10).
 */
const pctText = computed(() => Math.round(props.ratio * 100) + '%')
const width = computed(() => Math.max(props.ratio * 100, props.ratio > 0 ? 1 : 0))

const W = 70
const H = 16

const spark = computed(() => {
  const vals = props.series ?? []
  if (vals.length < 3) return null
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const pts = vals.map((v, i) => [
    (i / (vals.length - 1)) * W + 1,
    19 - ((v - min) / span) * H,
  ] as [number, number])
  const last = pts[pts.length - 1]!
  // Percentage points, not a percentage change: "heard-back went from 24% to
  // 26%" is +2 pts, and calling that +8% would be true and useless.
  const delta = (vals[vals.length - 1]! - vals[0]!) * 100
  return {
    d: 'M' + pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L'),
    x: last[0],
    y: last[1],
    delta: `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)} pts · 30d`,
    aria: `30-day trend, ${(vals[0]! * 100).toFixed(1)}% to ${(vals[vals.length - 1]! * 100).toFixed(1)}%`,
  }
})
</script>

<template>
  <PrimeCard class="stat-card" :aria-label="name">
    <template #content>
      <div class="stat-head">
        <p class="name">{{ name }}</p>
        <p class="pct mono" :style="{ color }">{{ pctText }}</p>
      </div>
      <div class="stat-track">
        <span class="stat-fill" :style="{ background: color, width: width + '%' }" />
      </div>
      <div class="stat-foot">
        <p class="sub mono">{{ sub }}</p>
        <!-- .attr on getter-only SVG geometry props so they never hit Vue's
             property-set hydration path (see CLAUDE.md). -->
        <svg v-if="spark" class="spark" width="72" height="22" viewBox="0 0 72 22" :aria-label="spark.aria">
          <path :d="spark.d" fill="none" :stroke="color" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.9" />
          <circle :cx.attr="spark.x" :cy.attr="spark.y" :r.attr="2" :fill="color" />
        </svg>
      </div>
      <p v-if="spark" class="delta mono">{{ spark.delta }}</p>
    </template>
  </PrimeCard>
</template>

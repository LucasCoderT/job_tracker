<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  name: string
  sub: string
  ratio: number
  color: string
}>()

const R = 30
const C = 38
const CIRC = 2 * Math.PI * R

// Small floor so a nonzero-but-tiny ratio still shows a visible tick.
const arc = computed(() => Math.max(CIRC * props.ratio, props.ratio > 0 ? 2 : 0))
const pctText = computed(() => Math.round(props.ratio * 100) + '%')
</script>

<template>
  <PrimeCard class="stat-card" :aria-label="name">
    <template #content>
      <div class="stat-inner">
        <div class="meta">
          <p class="name">{{ name }}</p>
          <p class="sub mono">{{ sub }}</p>
        </div>
        <!-- .attr on getter-only SVG geometry props (cx/cy/r/x/y/transform) so
             they never hit Vue's property-set hydration path. -->
        <svg class="donut" width="76" height="76" viewBox="0 0 76 76">
          <circle :cx.attr="C" :cy.attr="C" :r.attr="R" fill="none" stroke="var(--panel-edge)" stroke-width="6.5" />
          <circle
            :cx.attr="C"
            :cy.attr="C"
            :r.attr="R"
            fill="none"
            :stroke="color"
            stroke-width="6.5"
            stroke-linecap="round"
            :stroke-dasharray="`${arc} ${CIRC}`"
            :transform.attr="`rotate(-90 ${C} ${C})`"
          />
          <text class="value mono" :x.attr="C" :y.attr="C + 5" text-anchor="middle">{{ pctText }}</text>
        </svg>
      </div>
    </template>
  </PrimeCard>
</template>

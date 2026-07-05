<script setup lang="ts">
import { computed } from 'vue'
import type { WeekPoint } from '../../shared/types'

const props = defineProps<{ weekly: WeekPoint[] }>()
const { show, move, hide } = useTooltip()

// Fixed coordinate space; SVG scales to the panel via viewBox.
const W = 640
const H = 150
const PAD_B = 18
const PAD_T = 6

// Fixed locale so server-rendered labels match the client (no hydration drift).
function weekLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const bars = computed(() => {
  const weeks = props.weekly
  const n = weeks.length
  if (!n) return []
  const max = Math.max(...weeks.map((w) => w.applied)) || 1
  const gap = 3
  const bw = Math.max(4, (W - gap * (n - 1)) / n)
  const labelEvery = Math.max(1, Math.ceil(n / 6))
  const plot = H - PAD_B - PAD_T

  return weeks.map((w, i) => {
    const x = i * (bw + gap)
    const h = (plot * w.applied) / max
    const hr = (plot * w.replied) / max
    return {
      x,
      bw,
      applied: { y: H - PAD_B - h, h: Math.max(w.applied ? 2 : 0, h) },
      replied: w.replied ? { y: H - PAD_B - hr, h: Math.max(2, hr) } : null,
      showLabel: i % labelEvery === 0,
      label: weekLabel(w.week),
      tip:
        `<div class="t-head">Week of ${esc(weekLabel(w.week))}</div>` +
        `<div class="t-sub">${w.applied} applied · ${w.replied} got a reply (${pct(w.replied, w.applied)})</div>`,
    }
  })
})
</script>

<template>
  <!-- .attr on SVG geometry bindings forces setAttribute: getter-only props
       (x/y/width/height) would otherwise throw on hydration (Vue #svg-ns). -->
  <svg :viewBox.attr="`0 0 ${W} ${H}`">
    <g v-for="(b, i) in bars" :key="i" class="vbar">
      <rect :x.attr="b.x" :y.attr="b.applied.y" :width.attr="b.bw" :height.attr="b.applied.h" rx="2" fill="var(--stone)" opacity="0.55" />
      <rect
        v-if="b.replied"
        :x.attr="b.x"
        :y.attr="b.replied.y"
        :width.attr="b.bw"
        :height.attr="b.replied.h"
        rx="2"
        fill="var(--amber)"
      />
      <!-- full-height hover target -->
      <rect
        :x.attr="b.x"
        y="0"
        :width.attr="b.bw + 3"
        :height.attr="H"
        fill="transparent"
        @mouseenter="show(b.tip, $event)"
        @mousemove="move($event)"
        @mouseleave="hide()"
      />
      <text
        v-if="b.showLabel"
        :x.attr="b.x + b.bw / 2"
        :y.attr="H - 4"
        text-anchor="middle"
        fill="var(--faint)"
        font-size="10"
        font-family="'Spline Sans Mono', monospace"
      >
        {{ b.label }}
      </text>
    </g>
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Stats } from '../../shared/types'

const props = defineProps<{ stats: Stats }>()

/**
 * Replaces the Sankey. The Sankey showed where everything went but never
 * answered the question the page exists for — where the process leaks — and
 * it was unreadable on a phone (a fixed 800×400 coordinate space scaled to
 * 360px rendered its labels at about 5px; DESIGN.md §7.1).
 *
 * The step rate between stages is the headline instead: it names the
 * bottleneck outright. The bar underneath says where the applications are
 * sitting right now, which is the one thing the Sankey did well.
 *
 * Both the strip and the phone funnel render server-side and CSS decides
 * which is visible — measuring the viewport in JS would cost the SSR of
 * whichever one lost.
 */

const T = computed(() => props.stats.total)
const m = computed(() => props.stats.metrics)

const counts = computed(() => {
  const by: Record<string, number> = {}
  for (const b of props.stats.buckets) by[b.key] = b.count
  return by
})

/** Rejections that never got a conversation — a form reply, not a person. */
const rejectedCold = computed(
  () => counts.value.rejected! - props.stats.jobs.filter((j) => j.bucket === 'rejected' && j.stage).length,
)

const stages = computed(() => props.stats.stages)

interface Step {
  label: string
  n: number
  color: string
  ofAll: string
  step: string
  stepLabel: string
  lost: string
}

const strip = computed<Step[]>(() => {
  const c = counts.value
  const st = stages.value
  const r1 = st[0]?.reached ?? 0
  const r2 = st[1]?.reached ?? 0
  const rows: [string, number, string, string, string, string][] = [
    ['Applied', T.value, 'var(--text)', pct(m.value.heardBack, T.value), 'replied',
      `${c.noAnswer} silent past ${props.stats.staleDays} days; ${c.awaiting} still inside the window.`],
    ['Heard back', m.value.heardBack, 'var(--blue)', pct(r1, m.value.heardBack), 'to interview',
      `${rejectedCold.value} rejected without a conversation; ${c.pending} still talking.`],
    ['Interviewed', r1, 'var(--olive)', pct(r2, r1), 'to round 2',
      `${st[0]?.stoppedHere ?? 0} rejected after the screen.`],
    ['Round 2+', r2, 'var(--plum)', pct(m.value.offers, r2), 'to offer', `${c.progressing} in process.`],
    ['Offer', m.value.offers, 'var(--green)', '', '', ''],
  ]
  return rows.map(([label, n, color, step, stepLabel, lost]) => ({
    label, n, color, step, stepLabel, lost, ofAll: pct(n, T.value),
  }))
})

/** Where the applications are sitting right now — these partition the total. */
const outcomes = computed(() => {
  const c = counts.value
  const inProcess = c.pending! + c.interviewed! + c.progressing! + c.offerAccepted!
  return [
    { label: 'awaiting', n: c.awaiting!, color: 'var(--amber)' },
    { label: 'in process', n: inProcess, color: 'var(--green)' },
    { label: 'rejected', n: c.rejected! + c.offerDeclined!, color: 'var(--rust)' },
    { label: 'no answer', n: c.noAnswer!, color: 'var(--stone)' },
  ]
    .filter((o) => o.n > 0)
    .map((o) => ({ ...o, w: (o.n / T.value) * 100 }))
})

/** The phone layout: one labelled bar per stage, centred, nothing under 11px. */
const funnel = computed(() => {
  const st = stages.value
  const rows: [string, number, string, boolean][] = [
    ['Applications', T.value, 'var(--stone)', true],
    ['Heard back', m.value.heardBack, 'var(--blue)', true],
    ...st.slice(0, -1).map(
      (s, i) => [s.stage, s.reached, ['var(--olive)', 'var(--plum)', 'var(--teal)'][i]!, false] as [string, number, string, boolean],
    ),
    ['Offers', m.value.offers, 'var(--teal)', false],
  ]
  return rows.map(([label, n, color, strong]) => ({
    label, n, color, strong, pct: pct(n, T.value), w: Math.max(1.5, (n / T.value) * 100),
  }))
})
</script>

<template>
  <div class="strip-wrap">
    <!-- Wide: the step rate between stages is the headline -->
    <div class="strip">
      <div v-for="s in strip" :key="s.label" class="step">
        <p class="step-label">{{ s.label }}</p>
        <p class="step-n mono" :style="{ color: s.color }">{{ s.n }}</p>
        <p class="step-of mono">{{ s.ofAll }} of all</p>
        <template v-if="s.step">
          <p class="step-rate mono">
            → <b>{{ s.step }}</b><br />
            <span class="step-rate-label">{{ s.stepLabel }}</span>
          </p>
          <p class="step-lost">{{ s.lost }}</p>
        </template>
      </div>
    </div>

    <!-- Phone: a stacked funnel, every mark labelled -->
    <div class="funnel" role="img" aria-label="Application funnel, stage by stage">
      <div v-for="f in funnel" :key="f.label" class="fn-row">
        <div class="fn-head">
          <span :class="{ strong: f.strong }">{{ f.label }}</span>
          <span class="mono"><b>{{ f.n }}</b> · {{ f.pct }}</span>
        </div>
        <div class="fn-track"><span class="fn-fill" :style="{ background: f.color, width: f.w + '%' }" /></div>
      </div>
    </div>

    <!-- Both layouts: where the applications sit right now -->
    <div class="outcome">
      <p class="outcome-cap">Where the {{ T }} sit now</p>
      <div class="outcome-bar">
        <span v-for="o in outcomes" :key="o.label" :title="`${o.n} ${o.label}`" :style="{ background: o.color, width: o.w + '%' }" />
      </div>
      <div class="outcome-key mono">
        <span v-for="o in outcomes" :key="o.label" class="k">
          <span class="sw" :style="{ background: o.color }" /><b>{{ o.n }}</b> {{ o.label }}
        </span>
      </div>
    </div>
  </div>
</template>

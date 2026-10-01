<script setup lang="ts">
/**
 * What predicts a reply: outcomes by evaluation score, channel and what went
 * with the application, among applications old enough to have an outcome.
 * Then the pack test, once one is running. See server/utils/calibration.ts.
 *
 * One shared 0–100% scale across every row, so a bar can be compared with any
 * other bar in the panel; heard back is amber (a human replied), screens sit
 * inside it in olive, the funnel's colour for Round 1.
 */
import { computed } from 'vue'
import type { Calibration } from '../../shared/types'

const props = defineProps<{ cal: Calibration }>()

// career-ops's rule: no comparative claim under n=20. The row still shows,
// in fainter ink, because a direction is still worth seeing.
const THIN = 20

const groups = computed(() =>
  props.cal.groups
    .filter((g) => g.rows.length)
    .map((g) => ({
      ...g,
      rows: g.rows.map((r) => ({
        ...r,
        thin: r.n < THIN,
        heardW: (r.heard / r.n) * 100,
        screenW: (r.screens / r.n) * 100,
        rate: pct(r.heard, r.n),
      })),
    })),
)

const test = computed(() => {
  const t = props.cal.test
  if (!t) return null
  const label = { tailored: 'Tailored pack', base: 'Base CV, no letter' } as const
  return {
    ...t,
    rows: t.rows.map((r) => ({ ...r, label: label[r.arm], rate: r.due ? pct(r.replied, r.due) : '—', w: r.due ? (r.replied / r.due) * 100 : 0 })),
    tooEarly: t.rows.some((r) => r.due < THIN),
  }
})
</script>

<template>
  <div class="cal">
    <p v-if="!cal.mature" class="muted small">Nothing is {{ cal.matureDays }} days old yet, so nothing has an outcome to compare.</p>

    <template v-else>
      <p class="cal-scope muted">
        Applications at least {{ cal.matureDays }} days old ({{ cal.mature }}), when waiting has turned into an answer or
        silence. <span class="cal-key"><span class="sw heard" />heard back</span>
        <span class="cal-key"><span class="sw screen" />reached a screen</span>
      </p>

      <div class="cal-groups">
        <section v-for="g in groups" :key="g.key" class="cal-group" :aria-label="`Reply rate by ${g.title.toLowerCase()}`">
          <h3>{{ g.title }}</h3>
          <div v-for="r in g.rows" :key="r.label" class="src-row cal-row" :class="{ thin: r.thin }">
            <span class="dom">{{ r.label }}</span>
            <span class="src-bar">
              <span v-if="r.heard" class="rep" :style="{ width: r.heardW + '%' }" />
              <span v-if="r.screens" class="cal-screen" :style="{ width: r.screenW + '%' }" />
            </span>
            <span class="rate mono"><b>{{ r.rate }}</b> · {{ r.heard }}/{{ r.n }}<span class="cal-scr"> · {{ r.screens }} {{ r.screens === 1 ? 'screen' : 'screens' }}</span></span>
          </div>
        </section>
      </div>

      <p class="cal-foot faint mono">
        <template v-if="cal.replyDays.median !== null">median {{ cal.replyDays.median }} days to a reply (n={{ cal.replyDays.n }}) · </template>
        fainter rows have under 20, a direction rather than a result
      </p>
    </template>

    <section v-if="test" class="cal-test" aria-label="The pack test">
      <h3>The pack test</h3>
      <p class="muted small">
        Replied within {{ test.withinDays }} days, by the half each posting was assigned. Since
        <ClientOnly>{{ new Date(test.startedAt).toLocaleDateString('en-CA', { dateStyle: 'medium' }) }}</ClientOnly>.
      </p>
      <div v-for="r in test.rows" :key="r.arm" class="src-row cal-row" :class="{ thin: r.due < 20 }">
        <span class="dom">{{ r.label }}</span>
        <span class="src-bar"><span v-if="r.replied" class="rep" :style="{ width: r.w + '%' }" /></span>
        <span class="rate mono"><b>{{ r.rate }}</b> · {{ r.replied }}/{{ r.due }}</span>
      </div>
      <p class="cal-foot faint mono">
        {{ test.rows.map((r) => `${r.sent} sent ${r.arm === 'base' ? 'base' : 'tailored'}${r.deviated ? `, ${r.deviated} off-plan` : ''}`).join(' · ') }}
        <template v-if="test.tooEarly"> · too early to compare: each half needs 20 at {{ test.withinDays }} days</template>
      </p>
    </section>
  </div>
</template>

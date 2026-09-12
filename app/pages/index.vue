<script setup lang="ts">
import { computed } from 'vue'

const { data: stats, pending, error } = await useStats()
const config = useRuntimeConfig()
const notionUrl = computed(() => config.public.notionViewUrl)

// The badge is the whole point of the link: postings only matter while
// there are some he has not looked at.
const { postings, open: openPostings } = usePostings()

// Trends for the stat cards. Lazy and client-only — a card without a
// sparkline is still a correct card, so this must not hold up first paint.
const { snapshots } = useHistory()
const heardBackSeries = computed(() => metricSeries(snapshots.value, 'heardBackRate'))
const interviewSeries = computed(() => metricSeries(snapshots.value, 'interviewRate'))
const offerSeries = computed(() => metricSeries(snapshots.value, 'offerRate'))

/**
 * The lede: the finding, in words, before any chart.
 *
 * The page used to open with a diagram and leave the reader to derive the
 * one fact that should change behaviour. This states it (DESIGN.md §7.2).
 * Everything is guarded — a source set without LinkedIn or without an ATS
 * is normal early on, and the sentence just gets shorter.
 */
const lede = computed(() => {
  if (!stats.value) return null
  const s = stats.value
  const m = s.metrics
  const rest =
    `${m.heardBack} of ${s.total} applications ever heard back; ` +
    `${m.interviewed} reached an interview; ${m.offers} ${m.offers === 1 ? 'offer' : 'offers'}. ` +
    `${s.counts.awaiting} are still inside the ${s.staleDays}-day window.`

  const ats = s.sources
    .filter((x) => /ashby|greenhouse|lever|workday|rippling|breezy/i.test(x.domain))
    .reduce((a, x) => ({ total: a.total + x.total, replied: a.replied + x.replied }), { total: 0, replied: 0 })
  const li = s.sources.find((x) => /linkedin/i.test(x.domain))
  if (!li || !li.total || !li.replied || !ats.total || !ats.replied) return { strong: '', rest }

  const ratio = ats.replied / ats.total / (li.replied / li.total)
  if (!Number.isFinite(ratio) || ratio < 1.2) return { strong: '', rest }
  return {
    strong:
      `Applying through a company's own ATS gets a reply ${ratio.toFixed(1)}× as often as LinkedIn ` +
      `(${pct(ats.replied, ats.total)} vs ${pct(li.replied, li.total)}).`,
    rest,
  }
})

const footer = computed(() => {
  if (!stats.value) return ''
  return (
    `Updated ${new Date(stats.value.generatedAt).toLocaleString()}` +
    ` · cached 5 min · no-reply cutoff ${stats.value.staleDays}d`
  )
})
</script>

<template>
  <div>
    <header>
      <h1>Job Pipeline</h1>
      <div class="header-tools">
        <AddPostingButton />
        <PrimeButton
          as="a"
          href="/postings"
          :label="openPostings.length ? `Postings (${openPostings.length})` : 'Postings'"
          icon="pi pi-inbox"
          :severity="openPostings.length ? 'primary' : 'secondary'"
          :outlined="!openPostings.length"
          size="small"
        />
        <PrimeButton
          as="a"
          href="/packs"
          label="Interview packs"
          icon="pi pi-book"
          severity="secondary"
          outlined
          size="small"
        />
        <PrimeButton
          as="a"
          href="/ei"
          label="EI activity"
          icon="pi pi-calendar-clock"
          severity="secondary"
          outlined
          size="small"
        />
        <PrimeButton
          v-if="notionUrl"
          as="a"
          :href="notionUrl"
          target="_blank"
          rel="noopener"
          label="Open in Notion"
          icon="pi pi-external-link"
          icon-pos="right"
          severity="secondary"
          outlined
          size="small"
        />
      </div>
    </header>

    <p v-if="lede" class="lede">
      <span v-if="lede.strong" class="lede-strong">{{ lede.strong }}</span>
      {{ lede.rest }}
    </p>

    <!-- Skeletons at the real panel dimensions, so nothing jumps when the
         data lands (DESIGN.md §7.8). -->
    <div v-if="pending" class="skel" aria-busy="true" aria-label="Loading pipeline">
      <div class="grid">
        <div class="skel-panel skel-pipeline" />
        <div class="stats">
          <div class="skel-panel skel-stat sk" />
          <div class="skel-panel skel-stat sk" style="animation-delay: 120ms" />
          <div class="skel-panel skel-stat sk" style="animation-delay: 240ms" />
        </div>
      </div>
      <div class="row2">
        <div class="skel-panel skel-row2" />
        <div class="skel-panel skel-row2" />
      </div>
    </div>

    <PrimeMessage v-else-if="error" severity="error" :closable="false">
      Couldn't load pipeline data. {{ error.message }}
    </PrimeMessage>
    <PrimeMessage v-else-if="!stats || !stats.total" severity="secondary" :closable="false">
      No applications yet — add your first job in Notion and refresh.
    </PrimeMessage>

    <template v-else>
      <PostingsPreview :postings="postings" />

      <div class="grid">
        <PrimeCard class="sec sec--pipeline" aria-label="Application flow">
          <template #content>
            <h2>Pipeline</h2>
            <ConversionStrip :stats="stats" />
          </template>
        </PrimeCard>

        <aside class="stats">
          <StatCard
            name="Heard back"
            :sub="`${stats.metrics.heardBack} of ${stats.total}`"
            :ratio="stats.metrics.heardBackRate"
            color="var(--amber)"
            :series="heardBackSeries"
          />
          <StatCard
            name="Interview rate"
            :sub="`${stats.metrics.interviewed} of ${stats.total}`"
            :ratio="stats.metrics.interviewRate"
            color="var(--blue)"
            :series="interviewSeries"
          />
          <StatCard
            name="Offer rate"
            :sub="`${stats.metrics.offers} of ${stats.total}`"
            :ratio="stats.metrics.offerRate"
            color="var(--green)"
            :series="offerSeries"
          />
        </aside>
      </div>

      <!-- Weight order: the panel that changes behaviour comes first and
           widest; velocity is context (DESIGN.md §7.2). -->
      <div class="row2">
        <PrimeCard class="sec" aria-label="Reply rate by source">
          <template #content>
            <div class="sec-head">
              <h2>Reply rate by source</h2>
              <span class="sec-note">where the next hour goes</span>
            </div>
            <SourcesBreakdown :sources="stats.sources" />
          </template>
        </PrimeCard>

        <PrimeCard class="sec" aria-label="Applications per week">
          <template #content>
            <h2>Velocity</h2>
            <VelocityChart :weekly="stats.weekly" />
            <div class="legend">
              <span class="k"><span class="sw" style="background: var(--stone)" />applied · {{ stats.total }}</span>
              <span class="k"><span class="sw" style="background: var(--amber)" />got a reply · {{ stats.metrics.heardBack }}</span>
            </div>
          </template>
        </PrimeCard>
      </div>

      <!-- The footnotes: both say "source is the lever, this isn't", so they
           share one quiet panel rather than two cards of equal weight. -->
      <PrimeCard class="sec footnotes" aria-label="Reply rate by role type and salary context">
        <template #content>
          <div class="foot-col">
            <h2>Reply rate by role type</h2>
            <RolesBreakdown :roles="stats.roles" />
          </div>
          <div class="foot-col">
            <h2>Salary vs. reply</h2>
            <SalaryContext :salary="stats.salary" />
          </div>
        </template>
      </PrimeCard>

      <TrackerSection
        :buckets="stats.buckets"
        :jobs="stats.jobs"
        :total="stats.total"
        :stale-days="stats.staleDays"
      />

      <!-- Client-only: toLocaleString() is locale/timezone-dependent, so SSR
           and client disagree (hydration mismatch). A last-updated stamp is
           inherently a client-locale concern. -->
      <ClientOnly>
        <footer class="mono">{{ footer }}</footer>
      </ClientOnly>
    </template>

    <AppTooltip />
  </div>
</template>

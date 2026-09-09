<script setup lang="ts">
import { computed } from 'vue'

const { data: stats, pending, error } = await useStats()
const config = useRuntimeConfig()
const notionUrl = computed(() => config.public.notionViewUrl)

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

    <div v-if="pending" class="state"><PrimeProgressSpinner style="width: 44px; height: 44px" stroke-width="4" /></div>
    <PrimeMessage v-else-if="error" severity="error" :closable="false">
      Couldn't load pipeline data. {{ error.message }}
    </PrimeMessage>
    <PrimeMessage v-else-if="!stats || !stats.total" severity="secondary" :closable="false">
      No applications yet — add your first job in Notion and refresh.
    </PrimeMessage>

    <template v-else>
      <AttentionQueue :items="stats.attention" />

      <div class="grid">
        <PrimeCard class="sec sec--sankey" aria-label="Application flow">
          <template #content>
            <h2>Pipeline</h2>
            <PipelineSankey :stats="stats" />
          </template>
        </PrimeCard>

        <aside class="stats">
          <StatCard
            name="Heard back"
            :sub="`${stats.metrics.heardBack} of ${stats.total} ever replied`"
            :ratio="stats.metrics.heardBackRate"
            color="var(--amber)"
          />
          <StatCard
            name="Interview rate"
            :sub="`${stats.metrics.interviewed} of ${stats.total} applications`"
            :ratio="stats.metrics.interviewRate"
            color="var(--blue)"
          />
          <StatCard
            name="Offer rate"
            :sub="`${stats.metrics.offers} of ${stats.total} applications`"
            :ratio="stats.metrics.offerRate"
            color="var(--green)"
          />
        </aside>
      </div>

      <div class="row2">
        <PrimeCard class="sec" aria-label="Applications per week">
          <template #content>
            <h2>Velocity</h2>
            <VelocityChart :weekly="stats.weekly" />
            <div class="legend">
              <span class="k"><span class="sw" style="background: var(--stone)" />applied</span>
              <span class="k"><span class="sw" style="background: var(--amber)" />got a reply</span>
            </div>
          </template>
        </PrimeCard>

        <PrimeCard class="sec" aria-label="Reply rate by source">
          <template #content>
            <h2>Reply rate by source</h2>
            <SourcesBreakdown :sources="stats.sources" />
          </template>
        </PrimeCard>
      </div>

      <div class="row2">
        <PrimeCard class="sec" aria-label="Reply rate by role type">
          <template #content>
            <h2>Reply rate by role type</h2>
            <RolesBreakdown :roles="stats.roles" />
          </template>
        </PrimeCard>

        <PrimeCard class="sec" aria-label="Salary context">
          <template #content>
            <h2>Salary vs. reply</h2>
            <SalaryContext :salary="stats.salary" />
          </template>
        </PrimeCard>
      </div>

      <TrackerSection :buckets="stats.buckets" :jobs="stats.jobs" :total="stats.total" />

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

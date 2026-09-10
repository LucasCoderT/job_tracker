<script setup lang="ts">
import { computed } from 'vue'
import type { PostingMeta } from '../../shared/types'

const props = defineProps<{ postings: PostingMeta[] }>()

const MAX = 5

/**
 * Newest first, best score breaking the tie.
 *
 * The list page ranks by score, which is right for a queue you work through
 * but wrong for a dashboard: the same five would sit here until acted on and
 * this morning's finds would never surface. `firstSeen` is the date the scan
 * found it (date-only, so ties within a day are normal) — score orders those.
 */
const shown = computed(() =>
  props.postings
    .filter((p) => p.state === 'new')
    .slice()
    .sort(
      (a, b) =>
        String(b.firstSeen || b.createdAt).localeCompare(String(a.firstSeen || a.createdAt)) ||
        (b.score ?? -1) - (a.score ?? -1),
    )
    .slice(0, MAX),
)

const total = computed(() => props.postings.filter((p) => p.state === 'new').length)

function age(p: PostingMeta): string {
  const iso = p.firstSeen || p.createdAt
  if (!iso) return ''
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
  if (!Number.isFinite(days)) return ''
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`
}
</script>

<template>
  <PrimeCard v-if="shown.length" class="sec preview" aria-label="Postings worth a look">
    <template #content>
      <div class="pv-head">
        <h2 class="pv-title">Worth a look</h2>
        <NuxtLink to="/postings" class="pv-all">
          {{ total > shown.length ? `all ${total}` : 'all postings' }} <i class="pi pi-arrow-right" />
        </NuxtLink>
      </div>
      <div class="pv-row">
        <NuxtLink v-for="p in shown" :key="p.id" class="pv-card" :to="`/postings/${p.id}`">
          <span class="pv-score mono" :style="{ color: scoreColor(p.score) }">
            {{ p.score === null ? '—' : p.score.toFixed(1) }}
          </span>
          <p class="co">{{ p.company }}</p>
          <p v-if="p.role" class="role">{{ p.role }}</p>
          <!-- Client-only: a relative age is computed from the client's clock,
               so SSR and hydration disagree at a day boundary. -->
          <ClientOnly>
            <p v-if="age(p)" class="when mono">{{ age(p) }}</p>
          </ClientOnly>
        </NuxtLink>
      </div>
    </template>
  </PrimeCard>
</template>

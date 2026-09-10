<script setup lang="ts">
import { computed, ref } from 'vue'

useHead({ title: 'Postings' })

const { data, pending, error, postings, open } = usePostings()

// Dismissed postings collapse rather than vanish: the pile he said no to is
// the record of what the morning scan is getting wrong.
const showDismissed = ref(false)
const live = computed(() => postings.value.filter((p) => p.state !== 'dismissed'))
const dismissed = computed(() => postings.value.filter((p) => p.state === 'dismissed'))
const shown = computed(() => (showDismissed.value ? [...live.value, ...dismissed.value] : live.value))

function age(iso: string | null): string {
  if (!iso) return ''
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
  if (!Number.isFinite(days)) return ''
  return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`
}
</script>

<template>
  <div class="postings-page">
    <header>
      <div>
        <NuxtLink to="/" class="crumb"><i class="pi pi-arrow-left" /> Pipeline</NuxtLink>
        <h1>Postings</h1>
      </div>
      <div class="postings-head-tools">
        <AddPostingButton />
        <span v-if="postings.length" class="total mono">
          {{ open.length }} to look at<template v-if="dismissed.length"> · {{ dismissed.length }} dismissed</template>
        </span>
      </div>
    </header>

    <div v-if="pending" class="state"><PrimeProgressSpinner style="width: 44px; height: 44px" stroke-width="4" /></div>
    <PrimeMessage v-else-if="error" severity="error" :closable="false">
      Couldn't load postings. {{ error.message }}
    </PrimeMessage>
    <PrimeMessage v-else-if="data && !data.enabled" severity="warn" :closable="false">
      Postings are not enabled on this deploy (no POSTINGS KV binding).
    </PrimeMessage>
    <PrimeMessage v-else-if="!postings.length" severity="secondary" :closable="false">
      Nothing yet. The morning scan pushes anything it scores 4.0 or better.
    </PrimeMessage>

    <template v-else>
      <div class="postings-list">
        <NuxtLink
          v-for="p in shown"
          :key="p.id"
          :to="`/postings/${p.id}`"
          class="posting-row"
          :class="{ 'is-dismissed': p.state === 'dismissed' }"
        >
          <span class="score mono" :style="{ color: scoreColor(p.score) }">
            {{ p.score === null ? '—' : p.score.toFixed(1) }}
          </span>
          <div class="who">
            <p class="co">{{ p.company }}</p>
            <p class="role">{{ p.role || '—' }}</p>
          </div>
          <div class="facts">
            <p v-if="p.comp || p.geo" class="line" :title="[p.comp, p.geo].filter(Boolean).join(' · ')">
              <span v-if="p.comp" class="mono">{{ p.comp }}</span>
              <span v-if="p.comp && p.geo" class="sep">·</span>
              <span v-if="p.geo">{{ p.geo }}</span>
            </p>
            <p class="line dim">
              <span v-if="p.source" class="mono">{{ p.source }}</span>
              <ClientOnly>
                <template v-if="age(p.postedAt || p.firstSeen || p.createdAt)">
                  <span v-if="p.source" class="sep">·</span>
                  <span class="mono">{{ age(p.postedAt || p.firstSeen || p.createdAt) }}</span>
                </template>
              </ClientOnly>
            </p>
          </div>
          <div class="tags">
            <PrimeTag
              v-if="p.state !== 'new'"
              :value="POSTING_STATE_LABEL[p.state]"
              :severity="postingStateSeverity(p.state)"
            />
            <span v-if="p.pack !== 'none'" class="pack-chip" :class="'is-' + p.pack">
              <i class="pi pi-file-pdf" />
              {{ POSTING_PACK_LABEL[p.pack] }}
            </span>
          </div>
        </NuxtLink>
      </div>

      <button v-if="dismissed.length" type="button" class="linkish more" @click="showDismissed = !showDismissed">
        {{ showDismissed ? 'Hide' : 'Show' }} dismissed ({{ dismissed.length }})
      </button>
    </template>
  </div>
</template>

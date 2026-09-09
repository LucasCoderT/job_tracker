<script setup lang="ts">
import { computed } from 'vue'

useHead({ title: 'Interview packs' })
const { data, pending, error } = usePacks()
const packs = computed(() => data.value?.packs ?? [])

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })
}
</script>

<template>
  <div class="packs-page">
    <header>
      <div>
        <NuxtLink to="/" class="crumb"><i class="pi pi-arrow-left" /> Pipeline</NuxtLink>
        <h1>Interview packs</h1>
      </div>
    </header>

    <div v-if="pending" class="state"><PrimeProgressSpinner style="width: 44px; height: 44px" stroke-width="4" /></div>
    <PrimeMessage v-else-if="error" severity="error" :closable="false">Couldn't load packs. {{ error.message }}</PrimeMessage>
    <PrimeMessage v-else-if="data && !data.enabled" severity="warn" :closable="false">
      Packs are not enabled on this deploy (no PACKS KV binding).
    </PrimeMessage>
    <PrimeMessage v-else-if="!packs.length" severity="secondary" :closable="false">
      No packs yet. Press “Build pack” on a job in the tracker.
    </PrimeMessage>

    <div v-else class="packs-list">
      <NuxtLink v-for="p in packs" :key="p.jobId" :to="`/packs/${p.jobId}`" class="pack-row">
        <div class="who">
          <p class="co">{{ p.company }}</p>
          <p class="role">{{ p.position || '—' }}</p>
        </div>
        <PrimeTag :value="PACK_STATUS_LABEL[p.status] || p.status" :severity="packSeverity(p.status)" />
        <span class="counts mono">{{ p.answers }} cards · {{ p.beats }} beats<template v-if="p.exports.length"> · {{ p.exports.length }} exports</template></span>
        <ClientOnly><span class="stamp mono">{{ when(p.updatedAt) }}</span></ClientOnly>
      </NuxtLink>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { Job, PackMeta } from '../../shared/types'

// The pack's state on a job row: a link into the pack when one exists, or a
// one-click "Build pack" that queues it for the Mac and opens the page.
const props = defineProps<{ job: Job; pack: PackMeta | null | undefined }>()
const busy = ref(false)
const failed = ref('')

async function request() {
  if (busy.value) return
  busy.value = true
  failed.value = ''
  try {
    await $fetch(`/api/packs/${props.job.id}/request`, {
      method: 'POST',
      body: { company: props.job.company, position: props.job.position },
    })
    await navigateTo(`/packs/${props.job.id}`)
  } catch (err: any) {
    failed.value = err?.data?.statusMessage || err?.message || 'failed'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <NuxtLink v-if="pack" :to="`/packs/${job.id}`" class="pack-chip" :class="'is-' + pack.status" @click.stop>
    <i class="pi pi-book" />
    {{ PACK_STATUS_LABEL[pack.status] || pack.status }}
    <span v-if="pack.status === 'done'" class="mono n">{{ pack.answers }}</span>
  </NuxtLink>
  <button v-else type="button" class="pack-chip is-none" :disabled="busy" :title="failed || 'Queue a pack for the Mac to build'" @click.prevent.stop="request">
    <i :class="busy ? 'pi pi-spin pi-spinner' : 'pi pi-plus'" />
    {{ failed ? 'Retry' : 'Build pack' }}
  </button>
</template>

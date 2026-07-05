<script setup lang="ts">
import type { AttentionItem } from '../../shared/types'

defineProps<{ items: AttentionItem[] }>()
</script>

<template>
  <PrimeCard v-if="items.length" class="sec attention" aria-label="Needs attention">
    <template #content>
      <h2 class="attn-title">Needs attention · {{ items.length }}</h2>
      <div class="attn-row">
        <a
          v-for="(it, i) in items"
          :key="i"
          class="attn-card"
          :href="it.url || '#'"
          target="_blank"
          rel="noopener"
        >
          <p class="co">{{ it.company }}</p>
          <p v-if="it.position" class="role">{{ it.position }}</p>
          <span v-if="it.reason === 'followup'" class="why followup">
            Follow up{{ it.ageDays != null ? ' · ' + it.ageDays + 'd' : '' }}
          </span>
          <span v-else class="why aging">{{ it.ageDays }}d, no reply</span>
        </a>
      </div>
    </template>
  </PrimeCard>
</template>

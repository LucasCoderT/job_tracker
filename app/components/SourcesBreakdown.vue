<script setup lang="ts">
import { computed } from 'vue'
import type { Source } from '../../shared/types'

const props = defineProps<{ sources: Source[] }>()

const max = computed(() => Math.max(...props.sources.map((s) => s.total), 1))

// Bar widths as % of the busiest source (matches the original layout).
const rows = computed(() =>
  props.sources.map((s) => ({
    ...s,
    fillW: Math.max(3, (s.total / max.value) * 100),
    repW: s.replied ? Math.max(1.5, (s.replied / max.value) * 100) : 0,
    rate: pct(s.replied, s.total),
  })),
)
</script>

<template>
  <div id="sources-list">
    <div v-for="s in rows" :key="s.domain" class="src-row">
      <span class="dom">{{ s.domain }}</span>
      <span class="src-bar">
        <span class="fill" :style="{ width: s.fillW + '%' }" />
        <span v-if="s.replied" class="rep" :style="{ width: s.repW + '%' }" />
      </span>
      <span class="rate mono"><b>{{ s.rate }}</b> · {{ s.replied }}/{{ s.total }}</span>
    </div>
  </div>
</template>

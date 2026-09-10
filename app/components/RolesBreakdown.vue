<script setup lang="ts">
import { computed } from 'vue'
import type { RoleStat } from '../../shared/types'

const props = defineProps<{ roles: RoleStat[] }>()

const max = computed(() => Math.max(...props.roles.map((r) => r.total), 1))

// Same bar treatment as the sources chart, so the two read as a pair.
const rows = computed(() =>
  props.roles.map((r) => ({
    ...r,
    fillW: Math.max(3, (r.total / max.value) * 100),
    repW: r.replied ? Math.max(1.5, (r.replied / max.value) * 100) : 0,
    rate: pct(r.replied, r.total),
  })),
)
</script>

<template>
  <div id="roles-list">
    <div v-for="r in rows" :key="r.role" class="src-row">
      <span class="dom">{{ r.role }}</span>
      <span class="src-bar">
        <span class="fill" :style="{ width: r.fillW + '%' }" />
        <span v-if="r.replied" class="rep" :style="{ width: r.repW + '%' }" />
      </span>
      <span class="rate mono"><b>{{ r.rate }}</b> · {{ r.replied }}/{{ r.total }}</span>
    </div>
  </div>
</template>

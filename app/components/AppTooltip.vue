<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

// One shared tooltip element. HTML is built by the chart components (they
// escape any user text), so v-html is safe here.
const { state, PAD } = useTooltip()
const el = ref<HTMLElement | null>(null)
const pos = ref({ left: 0, top: 0 })

watch(
  () => [state.x, state.y, state.html, state.visible],
  async () => {
    if (!state.visible) return
    await nextTick()
    let left = state.x
    let top = state.y
    const r = el.value?.getBoundingClientRect()
    if (r) {
      // Flip to the other side of the cursor when it would overflow.
      if (left + r.width > window.innerWidth - 8) left = state.x - r.width - PAD * 2
      if (top + r.height > window.innerHeight - 8) top = state.y - r.height - PAD * 2
    }
    pos.value = { left, top }
  },
)
</script>

<template>
  <div
    v-show="state.visible"
    id="tip"
    ref="el"
    role="tooltip"
    :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
    v-html="state.html"
  />
</template>

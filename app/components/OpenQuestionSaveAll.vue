<script setup lang="ts">
/**
 * The bar that appears once something is unsaved. It sticks to the bottom of
 * the list, so after filling in the tenth box the button is under his thumb
 * and not ten boxes up.
 */
defineProps<{ count: number; busy: boolean; note: { text: string; error: boolean } | null }>()
defineEmits<{ save: [] }>()
</script>

<template>
  <div v-if="count || note" class="oq-saveall" :class="{ idle: !count }" role="status">
    <span v-if="count" class="oq-saveall-n">{{ count }} unsaved {{ count === 1 ? 'answer' : 'answers' }}</span>
    <span v-if="note" class="oq-saveall-note" :class="{ 'is-error': note.error }">{{ note.text }}</span>
    <span v-else-if="count" class="oq-saveall-note">Kept in this browser until you save.</span>
    <PrimeButton v-if="count" :label="count === 1 ? 'Save' : `Save all ${count}`" size="small" :loading="busy" @click="$emit('save')" />
  </div>
</template>

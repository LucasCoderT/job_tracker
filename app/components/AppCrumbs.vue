<script setup lang="ts">
import type { Crumb } from '../composables/useTrail'

/**
 * The trail at the top of a detail page: Pipeline › Postings › Acme.
 *
 * PrimeBreadcrumb owns the markup (nav + ordered list + aria-current), with
 * NuxtLink in its item slot so the links stay client-side routes. The back
 * arrow on the left is kept from the old single crumb: on a phone it is the
 * thing he actually presses, and it points at the page he came from.
 */
const props = defineProps<{ crumbs: Crumb[] }>()

const back = computed(() => [...props.crumbs].reverse().find((c) => c.to))
const model = computed(() => props.crumbs.map((c) => ({ label: c.label, route: c.to })))
</script>

<template>
  <div class="crumbs">
    <NuxtLink v-if="back?.to" :to="back.to" class="crumb-back" :aria-label="`Back to ${back.label}`">
      <i class="pi pi-arrow-left" />
    </NuxtLink>
    <PrimeBreadcrumb :model="model" :home="undefined" :pt="{ root: { 'aria-label': 'Breadcrumb' } }">
      <template #item="{ item }">
        <NuxtLink v-if="item.route" :to="item.route" class="crumb-link">{{ item.label }}</NuxtLink>
        <span v-else class="crumb-here">{{ item.label }}</span>
      </template>
      <template #separator><i class="pi pi-angle-right crumb-sep" /></template>
    </PrimeBreadcrumb>
  </div>
</template>

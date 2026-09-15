<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EiCandidate, EiTimeSpent } from '../../shared/types'
// Runtime value, so it goes through the #shared alias (see pages/ei.vue).
import { EI_TIME_OPTIONS } from '#shared/types'

/**
 * One proposed EI row: what it is, why the site thinks he did it, and the
 * time box. Shared by the week page and the "Log EI time" dialog, so the two
 * cannot drift into showing the same activity differently.
 */
const props = defineProps<{
  row: EiCandidate
  /** The week page lists seven days; the day dialog is all one day. */
  showDay?: boolean
}>()
const hours = defineModel<EiTimeSpent | null>('hours', { default: null })
const dropped = defineModel<boolean>('dropped', { default: false })
const open = ref(false)

const METHOD_ICON: Record<string, string> = {
  'Applied online': 'pi pi-send',
  'Resume/cover letter prep': 'pi pi-file-edit',
  'Searched online': 'pi pi-search',
  'Attended interview': 'pi pi-users',
  'Email application': 'pi pi-envelope',
  Networking: 'pi pi-share-alt',
}

const dayName = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })

/** Suggestions explain themselves, and step aside once he has chosen. */
const usingSuggestion = computed(() => hours.value === props.row.suggested)
</script>

<template>
  <div class="ei-row" :class="{ dropped, compact: !showDay }">
    <div class="ei-when mono">
      <span v-if="showDay" class="ei-day">{{ dayName(row.date) }}</span>
      <span class="ei-method"><i :class="METHOD_ICON[row.method] || 'pi pi-circle'" />{{ row.method }}</span>
    </div>

    <div class="ei-what">
      <p class="ei-activity">{{ row.activity }}</p>
      <p v-if="row.notes" class="ei-notes">{{ row.notes }}</p>
      <p v-if="row.sameDayLogged.length" class="ei-dupe">
        <i class="pi pi-exclamation-triangle" />
        Already logged that day under {{ row.method }}:
        <span v-for="(l, i) in row.sameDayLogged" :key="i" class="mono">{{ i ? ' · ' : '' }}“{{ l }}”</span>
      </p>
      <button type="button" class="linkish ei-why" @click="open = !open">
        {{ open ? 'hide' : 'why this is here' }} ({{ row.evidence.length }})
      </button>
      <ul v-if="open" class="ei-evidence mono">
        <li v-for="(e, i) in row.evidence" :key="i">{{ e }}</li>
      </ul>
    </div>

    <div class="ei-time-col">
      <div class="ei-time">
        <PrimeSelect
          v-model="hours"
          :options="EI_TIME_OPTIONS"
          placeholder="Time"
          size="small"
          :disabled="dropped"
          class="ei-select"
          :aria-label="`Time spent on ${row.activity}`"
        />
        <button
          type="button"
          class="icon-btn danger"
          :title="dropped ? 'Put it back' : 'This did not happen — drop it'"
          :aria-label="dropped ? `Restore ${row.activity}` : `Drop ${row.activity}`"
          @click="dropped = !dropped"
        >
          <i :class="dropped ? 'pi pi-undo' : 'pi pi-times'" />
        </button>
      </div>
      <p v-if="row.suggestedWhy && !dropped" class="ei-suggest mono">
        <template v-if="usingSuggestion">≈ {{ row.suggestedWhy }}</template>
        <template v-else>
          suggest {{ row.suggested }}
          <button type="button" class="linkish" @click="hours = row.suggested">use</button>
        </template>
      </p>
    </div>
  </div>
</template>

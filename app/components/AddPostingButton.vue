<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import type { PostingCreateResult } from '../../shared/types'
import { blockedSource } from '#shared/postings'

/**
 * Add a posting by URL — the ones a friend sends, which the morning scan will
 * never find.
 *
 * Only the URL is asked for. Company and role are optional because the
 * evaluation worker fills them in from the JD within the half hour: a posting
 * with no valid evaluation is exactly what it drains, so pasting a link is
 * the whole job.
 *
 * Except where the source refuses to be read. An Indeed link pasted on its own
 * became a row reading "indeed.com" with an empty role and no score — saved,
 * but unrecognisable among a hundred and fifty others, which is how "add
 * posting doesn't work" looks from the outside. Those sources ask for the
 * company and role up front, because nothing downstream can supply them.
 */
const open = ref(false)
const url = ref('')
const company = ref('')
const role = ref('')
const busy = ref(false)
const error = ref('')
const urlField = ref<{ $el?: HTMLElement } | null>(null)
const blocked = computed(() => blockedSource(url.value.trim()))
const needsDetails = computed(() => Boolean(blocked.value) && !company.value.trim())

async function show() {
  open.value = true
  error.value = ''
  await nextTick()
  // Straight to the field: this dialog exists to receive a paste.
  urlField.value?.$el?.querySelector?.('input')?.focus?.()
  ;(urlField.value?.$el as HTMLInputElement | undefined)?.focus?.()
}

function reset() {
  url.value = ''
  company.value = ''
  role.value = ''
  error.value = ''
}

async function submit() {
  if (!url.value.trim() || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const res = await $fetch<PostingCreateResult>('/api/postings', {
      method: 'POST',
      body: { url: url.value.trim(), company: company.value.trim(), role: role.value.trim() },
    })
    open.value = false
    reset()
    // No refresh: this navigates, and a second useFetch on the 'postings' key
    // from inside a header component flips the list page's `pending` back to
    // true mid-render, so it server-renders its skeleton instead of the rows.
    await navigateTo(`/postings/${res.meta.id}`)
  } catch (err: any) {
    error.value = err?.data?.statusMessage || err?.message || "Couldn't add that posting"
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <PrimeButton
    label="Add posting"
    icon="pi pi-plus"
    severity="secondary"
    outlined
    size="small"
    @click="show"
  />

  <PrimeDialog
    v-model:visible="open"
    modal
    header="Add a posting"
    :style="{ width: 'min(440px, calc(100vw - 32px))' }"
    @hide="reset"
  >
    <form class="add-posting" @submit.prevent="submit">
      <label>
        <span>Job posting URL</span>
        <PrimeInputText
          ref="urlField"
          v-model="url"
          placeholder="https://jobs.lever.co/…"
          autocomplete="off"
          inputmode="url"
          autofocus
        />
      </label>
      <PrimeMessage v-if="blocked" severity="warn" :closable="false" class="add-blocked">
        {{ blocked }} blocks automated reading, so nothing can fill these in for you. Add the company and
        role now or this will be saved as a row you cannot recognise later.
      </PrimeMessage>

      <div class="two">
        <label>
          <span>Company <small>{{ blocked ? 'needed here' : 'optional' }}</small></span>
          <PrimeInputText v-model="company" autocomplete="off" :invalid="needsDetails" />
        </label>
        <label>
          <span>Role <small>{{ blocked ? 'needed here' : 'optional' }}</small></span>
          <PrimeInputText v-model="role" autocomplete="off" />
        </label>
      </div>
      <p v-if="!blocked" class="add-hint">
        The Mac evaluates it within the half hour and fills in the rest — score, requirements, gaps.
      </p>
      <p v-else class="add-hint">
        The evaluation needs a job description and this source will not give one up. Paste the description
        on the posting afterwards and the evaluation runs as normal.
      </p>
      <PrimeMessage v-if="error" severity="error" :closable="false">{{ error }}</PrimeMessage>
      <div class="add-actions">
        <PrimeButton label="Cancel" severity="secondary" text size="small" @click="open = false" />
        <PrimeButton
          type="submit"
          label="Add"
          icon="pi pi-plus"
          size="small"
          :loading="busy"
          :disabled="!url.trim()"
        />
      </div>
    </form>
  </PrimeDialog>
</template>

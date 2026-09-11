<script setup lang="ts">
import { ref, nextTick } from 'vue'
import type { PostingCreateResult } from '../../shared/types'

/**
 * Add a posting by URL — the ones a friend sends, which the morning scan will
 * never find.
 *
 * Only the URL is asked for. Company and role are optional because the
 * evaluation worker fills them in from the JD within the half hour: a posting
 * with no valid evaluation is exactly what it drains, so pasting a link is
 * the whole job.
 */
const open = ref(false)
const url = ref('')
const company = ref('')
const role = ref('')
const busy = ref(false)
const error = ref('')
const urlField = ref<{ $el?: HTMLElement } | null>(null)

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
      <div class="two">
        <label>
          <span>Company <small>optional</small></span>
          <PrimeInputText v-model="company" autocomplete="off" />
        </label>
        <label>
          <span>Role <small>optional</small></span>
          <PrimeInputText v-model="role" autocomplete="off" />
        </label>
      </div>
      <p class="add-hint">
        The Mac evaluates it within the half hour and fills in the rest — score, requirements, gaps.
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

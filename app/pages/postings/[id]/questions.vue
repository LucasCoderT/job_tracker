<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { PostingDetail, PostingQuestion, PostingQuestions } from '../../../../shared/types'

const route = useRoute()
const id = computed(() => String(route.params.id))

const { data: posting } = await useFetch<PostingDetail>(() => `/api/postings/${id.value}`, {
  key: () => `posting:${id.value}`,
})
const { data, pending, error, refresh } = await useFetch<PostingQuestions>(
  () => `/api/postings/${id.value}/questions`,
  { key: () => `questions:${id.value}` },
)

const meta = computed(() => posting.value?.meta)
const questions = computed(() => data.value?.questions ?? [])
useHead({ title: () => (meta.value ? `${meta.value.company} — questions` : 'Questions') })

const STATUS_LABEL: Record<string, string> = {
  none: 'Not drafted',
  requested: 'Queued',
  building: 'Drafting…',
  done: 'Drafted',
  failed: 'Failed',
}
const STATUS_ICON: Record<string, string> = {
  none: 'pi pi-pencil',
  requested: 'pi pi-clock',
  building: 'pi pi-spin pi-spinner',
  done: 'pi pi-check-circle',
  failed: 'pi pi-exclamation-triangle',
}

const answered = computed(() => questions.value.filter((q) => q.answer.trim()).length)
const inFlight = computed(() => data.value?.status === 'requested' || data.value?.status === 'building')

// ---- paste ----
const paste = ref('')
const editing = ref(false)
const busy = ref('')
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | undefined

function say(text: string) {
  clearTimeout(toastTimer)
  toast.value = text
  toastTimer = setTimeout(() => (toast.value = ''), 4000)
}

function openEditor() {
  paste.value = questions.value.map((q) => q.question).join('\n')
  editing.value = true
}

async function savePaste() {
  busy.value = 'paste'
  try {
    await $fetch(`/api/postings/${id.value}/questions`, { method: 'PUT', body: { text: paste.value } })
    await refresh()
    editing.value = false
    say('Questions saved. Answers you already had are kept.')
  } catch (err: any) {
    say(err?.data?.statusMessage || err?.message || "Couldn't save the questions")
  } finally {
    busy.value = ''
  }
}

// ---- drafting ----
const note = ref('')
const draftOpen = ref(false)

async function draft() {
  draftOpen.value = false
  busy.value = 'draft'
  try {
    await $fetch(`/api/postings/${id.value}/questions/request`, { method: 'POST', body: { note: note.value } })
    await refresh()
    say('Queued. The Mac drafts them from your CV and the JD, usually within the hour.')
  } catch (err: any) {
    say(err?.data?.statusMessage || err?.message || "Couldn't queue the draft")
  } finally {
    busy.value = ''
  }
}

// ---- per-answer editing ----
const drafts = ref<Record<string, string>>({})

// Only seed a box he is not currently typing in — a refresh landing mid-edit
// must not overwrite what he has written.
watch(
  questions,
  (list) => {
    for (const q of list) if (drafts.value[q.id] === undefined) drafts.value[q.id] = q.answer
  },
  { immediate: true },
)

const dirty = (q: PostingQuestion) => (drafts.value[q.id] ?? '') !== q.answer

async function saveAnswer(q: PostingQuestion) {
  busy.value = q.id
  try {
    await $fetch(`/api/postings/${id.value}/questions/${q.id}`, {
      method: 'PUT',
      body: { answer: drafts.value[q.id] ?? '' },
    })
    await refresh()
    say('Saved.')
  } catch (err: any) {
    say(err?.data?.statusMessage || err?.message || "Couldn't save that answer")
  } finally {
    busy.value = ''
  }
}

function revert(q: PostingQuestion) {
  drafts.value = { ...drafts.value, [q.id]: q.answer }
}

/**
 * The point of the page: get the answer into the form. Falls back to a select
 * when the clipboard is unavailable — an insecure origin, or a browser that
 * refuses without a user-gesture it did not recognise.
 */
async function copy(q: PostingQuestion, event: MouseEvent) {
  const text = drafts.value[q.id] ?? q.answer
  try {
    await navigator.clipboard.writeText(text)
    say('Copied.')
  } catch {
    const box = (event.currentTarget as HTMLElement)
      ?.closest('.qa')
      ?.querySelector('textarea') as HTMLTextAreaElement | null
    box?.select()
    say('Copy failed — the answer is selected, press ⌘C.')
  }
}

async function copyAll() {
  const text = questions.value
    .filter((q) => (drafts.value[q.id] ?? q.answer).trim())
    .map((q) => `${q.question}\n\n${drafts.value[q.id] ?? q.answer}`)
    .join('\n\n---\n\n')
  if (!text) return say('Nothing to copy yet.')
  try {
    await navigator.clipboard.writeText(text)
    say(`Copied ${answered.value} answer${answered.value === 1 ? '' : 's'}.`)
  } catch {
    say('Copy failed — copy them one at a time.')
  }
}

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0)
</script>

<template>
  <div class="postings-page questions-page">
    <header>
      <div>
        <NuxtLink :to="`/postings/${id}`" class="crumb"><i class="pi pi-arrow-left" /> Back to the posting</NuxtLink>
        <h1 v-if="meta">
          Application questions<span class="pos"> · {{ meta.company }}</span>
        </h1>
      </div>
      <div v-if="data" class="brief-meta mono">
        <span class="status-pill" :class="data.status">
          <i :class="STATUS_ICON[data.status]" />{{ STATUS_LABEL[data.status] }}
        </span>
        <span v-if="questions.length">{{ answered }} of {{ questions.length }} answered</span>
      </div>
    </header>

    <div v-if="pending" class="skel" aria-busy="true" aria-label="Loading questions">
      <div class="skel-panel sk" style="height: 120px; margin-bottom: 14px" />
      <div class="skel-panel sk" style="height: 360px; animation-delay: 120ms" />
    </div>

    <PrimeMessage v-else-if="error" severity="error" :closable="false">
      {{ error.statusCode === 404 ? 'No such posting.' : error.message }}
    </PrimeMessage>

    <template v-else-if="data">
      <PrimeMessage v-if="data.status === 'failed' && data.error" severity="error" :closable="false">
        {{ data.error }}
      </PrimeMessage>

      <!-- Paste: the whole capture step -->
      <PrimeCard v-if="!questions.length || editing" class="sec" aria-label="Paste the questions">
        <template #content>
          <h2>{{ questions.length ? 'Edit the questions' : 'Paste the questions' }}</h2>
          <p class="muted small paste-hint">
            One per line, straight off the application form. Numbering, bullets and the asterisk marking a
            required field are stripped for you.
          </p>
          <PrimeTextarea
            v-model="paste"
            rows="7"
            placeholder="Why do you want to work here?&#10;Describe a system you owned end to end.&#10;What are your salary expectations?"
            autocomplete="off"
          />
          <div class="paste-actions">
            <PrimeButton v-if="questions.length" label="Cancel" severity="secondary" text size="small" @click="editing = false" />
            <PrimeButton
              :label="questions.length ? 'Save questions' : 'Add questions'"
              icon="pi pi-check"
              size="small"
              :loading="busy === 'paste'"
              :disabled="!paste.trim()"
              @click="savePaste"
            />
          </div>
        </template>
      </PrimeCard>

      <template v-if="questions.length && !editing">
        <div class="q-tools">
          <PrimeButton
            :label="data.status === 'none' ? 'Draft answers' : inFlight ? 'Drafting…' : 'Redraft all'"
            :icon="inFlight ? 'pi pi-spin pi-spinner' : 'pi pi-sparkles'"
            size="small"
            :disabled="inFlight"
            :loading="busy === 'draft'"
            @click="draftOpen = true"
          />
          <PrimeButton label="Copy all" icon="pi pi-copy" size="small" severity="secondary" outlined :disabled="!answered" @click="copyAll" />
          <PrimeButton label="Edit questions" icon="pi pi-pencil" size="small" severity="secondary" text @click="openEditor" />
          <span v-if="data.note" class="q-note mono">“{{ data.note }}”</span>
        </div>

        <PrimeMessage v-if="inFlight" severity="info" :closable="false">
          The Mac is drafting these from your CV and the job description. They land here when it is done.
        </PrimeMessage>

        <div class="qa-list">
          <PrimeCard v-for="(q, i) in questions" :key="q.id" class="sec qa" :aria-label="q.question">
            <template #content>
              <div class="qa-head">
                <span class="qa-n mono">{{ i + 1 }}</span>
                <h3>{{ q.question }}</h3>
              </div>
              <PrimeTextarea
                v-model="drafts[q.id]"
                rows="5"
                :placeholder="inFlight ? 'Being drafted…' : 'Not drafted yet — write it here, or press Draft answers.'"
                autocomplete="off"
              />
              <div class="qa-foot">
                <span class="qa-meta mono">
                  {{ words(drafts[q.id] ?? '') }} words
                  <template v-if="q.source === 'edited'"> · your words</template>
                  <template v-else-if="q.source === 'drafted'"> · drafted</template>
                </span>
                <span class="qa-acts">
                  <template v-if="dirty(q)">
                    <button type="button" class="linkish" @click="revert(q)">revert</button>
                    <PrimeButton label="Save" icon="pi pi-check" size="small" :loading="busy === q.id" @click="saveAnswer(q)" />
                  </template>
                  <PrimeButton
                    label="Copy"
                    icon="pi pi-copy"
                    size="small"
                    severity="secondary"
                    outlined
                    :disabled="!(drafts[q.id] ?? '').trim()"
                    @click="copy(q, $event)"
                  />
                </span>
              </div>
            </template>
          </PrimeCard>
        </div>
      </template>

      <PrimeDialog
        v-model:visible="draftOpen"
        modal
        :header="data.status === 'none' ? 'Draft the answers' : 'Redraft the answers'"
        :style="{ width: 'min(520px, calc(100vw - 32px))' }"
      >
        <div class="build-dialog">
          <p class="muted small">
            The Mac answers each question from your CV, the job description and this posting's evaluation —
            in your voice, not a generic one. A note steers tone and emphasis across all
            {{ questions.length }}.
          </p>
          <p v-if="answered" class="muted small">
            <b>{{ answered }}</b> already {{ answered === 1 ? 'has an answer' : 'have answers' }}; a redraft
            replaces every one of them, including anything you edited yourself.
          </p>
          <label>
            <span>Note for the draft <small>optional</small></span>
            <PrimeTextarea v-model="note" rows="4" :placeholder="data.note || 'Keep them under 150 words, first person…'" autocomplete="off" />
          </label>
        </div>
        <template #footer>
          <PrimeButton label="Cancel" severity="secondary" text size="small" @click="draftOpen = false" />
          <PrimeButton
            :label="data.status === 'none' ? 'Draft answers' : 'Redraft'"
            icon="pi pi-sparkles"
            size="small"
            :loading="busy === 'draft'"
            @click="draft"
          />
        </template>
      </PrimeDialog>

      <Transition name="toast">
        <div v-if="toast" class="toast" role="status">
          <i class="pi pi-check-circle" />
          <span>{{ toast }}</span>
          <button type="button" class="toast-x" aria-label="Dismiss" @click="toast = ''"><i class="pi pi-times" /></button>
        </div>
      </Transition>
    </template>
  </div>
</template>

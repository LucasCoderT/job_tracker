<script setup lang="ts">
/**
 * One open question and the place to answer it.
 *
 * The same row serves both kinds. A question about him has the yes / some / no
 * chips, since most of them are "do you have X", and its answer applies to
 * every posting. A question for the employer has only the text, and belongs to
 * the one posting.
 *
 * Nothing here writes for him. The box is a place to type, the same rule the
 * answer bank and the screen prep keep, and it matters more here: what he
 * types is what a later CV or cover letter may repeat.
 */
import type { EmployerQuestion, FactVerdict, ProfileQuestion } from '../../shared/types'

const props = defineProps<{
  kind: 'about' | 'employer'
  q: ProfileQuestion | EmployerQuestion
  /** Hide the "asked by" line where the posting is already the page. */
  bare?: boolean
}>()
const emit = defineEmits<{ saved: [q: ProfileQuestion | EmployerQuestion]; removed: [id: string] }>()

const about = computed(() => (props.kind === 'about' ? (props.q as ProfileQuestion) : null))
const employer = computed(() => (props.kind === 'employer' ? (props.q as EmployerQuestion) : null))

const text = ref(props.q.answer ?? '')
const verdict = ref<FactVerdict | null>(about.value?.verdict ?? null)
const editing = ref(!props.q.answeredAt)
const busy = ref(false)
const note = ref<{ text: string; error: boolean } | null>(null)
const armed = ref(false)
let armTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(armTimer))

// ---- drafts ----
//
// What he has typed and not saved is kept in this browser, per question, so a
// reload, a closed tab or a trip to another posting does not cost him the
// text. Read after mount, never during setup: the server has no drafts, and
// restoring one while hydrating would make the first client render disagree
// with the markup it was sent.
const draftKey = () => `oq.draft.${props.kind}.${props.q.id}`
const restored = ref(false)
function dropDraft() {
  try {
    localStorage.removeItem(draftKey())
  } catch {
    /* no storage: nothing was kept, nothing to drop */
  }
  restored.value = false
}
function restoreDraft() {
  try {
    const raw = localStorage.getItem(draftKey())
    if (!raw) return
    const d = JSON.parse(raw)
    const t = typeof d?.text === 'string' ? d.text : ''
    const v = (['yes', 'some', 'no'] as const).includes(d?.verdict) ? (d.verdict as FactVerdict) : null
    // A draft equal to what is stored is not a draft any more.
    if (t.trim() === (props.q.answer ?? '') && v === (about.value?.verdict ?? null)) return dropDraft()
    text.value = t
    verdict.value = props.kind === 'about' ? v : null
    editing.value = true
    restored.value = true
  } catch {
    /* blocked storage or a damaged entry: start from what is stored */
  }
}
onMounted(restoreDraft)

// A different question in the same slot (the list re-sorted) starts clean.
watch(() => props.q.id, () => {
  text.value = props.q.answer ?? ''
  verdict.value = about.value?.verdict ?? null
  editing.value = !props.q.answeredAt
  note.value = null
  restored.value = false
  restoreDraft()
})

const VERDICTS: { value: FactVerdict; label: string }[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'some', label: 'Some' },
  { value: 'no', label: 'No' },
]
const VERDICT_WORD: Record<FactVerdict, string> = { yes: 'Yes', some: 'Some', no: 'No' }

const canSave = computed(() => Boolean(text.value.trim() || verdict.value))
const dirty = computed(() => text.value.trim() !== (props.q.answer ?? '') || verdict.value !== (about.value?.verdict ?? null))
const askers = computed(() => about.value?.askedBy ?? [])

// Keep the draft in step with the box. Not dirty means nothing to keep.
watch([text, verdict], () => {
  try {
    if (dirty.value) localStorage.setItem(draftKey(), JSON.stringify({ text: text.value, verdict: verdict.value }))
    else localStorage.removeItem(draftKey())
  } catch {
    /* private mode or full storage: the box still works, it just is not kept */
  }
})

function done(saved: ProfileQuestion | EmployerQuestion) {
  // Show exactly what was stored (the server trims), so the row is not dirty against it.
  text.value = saved.answer ?? ''
  editing.value = false
  note.value = null
  dropDraft()
  emit('saved', saved)
}

// The page's "Save all" sees this row while it has something worth saving.
useOpenQuestionBulkRow({
  kind: props.kind,
  id: props.q.id,
  dirty: () => editing.value && dirty.value && canSave.value,
  payload: () => ({ kind: props.kind, id: props.q.id, answer: text.value, verdict: verdict.value }),
  done,
})
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '')

async function save() {
  if (!canSave.value || busy.value) return
  busy.value = true
  note.value = null
  try {
    const saved = await $fetch<ProfileQuestion | EmployerQuestion>(`/api/facts/${props.kind}/${props.q.id}`, {
      method: 'PUT',
      body: { answer: text.value, verdict: verdict.value },
    })
    done(saved)
  } catch (err: any) {
    note.value = { text: err?.data?.statusMessage || 'Could not save. Your text is still here.', error: true }
  } finally {
    busy.value = false
  }
}

function cancel() {
  text.value = props.q.answer ?? ''
  verdict.value = about.value?.verdict ?? null
  editing.value = false
  dropDraft()
}

/** Throw the unsaved text away, back to what is stored (or to empty). */
function discard() {
  text.value = props.q.answer ?? ''
  verdict.value = about.value?.verdict ?? null
  dropDraft()
}

// Two presses: an answer is his writing and a delete does not come back.
async function remove() {
  if (!armed.value) {
    armed.value = true
    armTimer = setTimeout(() => (armed.value = false), 4000)
    return
  }
  clearTimeout(armTimer)
  busy.value = true
  try {
    await $fetch(`/api/facts/${props.kind}/${props.q.id}`, { method: 'DELETE' })
    dropDraft()
    emit('removed', props.q.id)
  } catch {
    note.value = { text: 'Could not remove it.', error: true }
    armed.value = false
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="oq" :class="{ answered: q.answeredAt && !editing }">
    <div class="oq-head">
      <span class="oq-kind" :class="kind">{{ kind === 'about' ? about?.topic : 'For the employer' }}</span>
      <span v-if="q.answeredAt && !editing" class="oq-when mono">
        <ClientOnly>answered {{ when(q.answeredAt) }}</ClientOnly>
      </span>
    </div>
    <p class="oq-q">{{ q.question }}</p>

    <template v-if="q.answeredAt && !editing">
      <p class="oq-a">
        <span v-if="about?.verdict" class="oq-verdict" :class="about.verdict">{{ VERDICT_WORD[about.verdict] }}</span>
        <span v-if="q.answer" class="oq-a-text">{{ q.answer }}</span>
      </p>
      <div class="oq-foot">
        <button type="button" class="linkish oq-link" @click="editing = true">Edit</button>
        <button type="button" class="linkish oq-link" :class="{ danger: armed }" :disabled="busy" @click="remove">
          {{ armed ? 'Press again to remove' : 'Remove' }}
        </button>
      </div>
    </template>

    <template v-else>
      <div v-if="kind === 'about'" class="oq-chips" role="group" :aria-label="`${about?.topic}: yes, some or no`">
        <button
          v-for="v in VERDICTS"
          :key="v.value"
          type="button"
          class="oq-chip"
          :class="[v.value, { on: verdict === v.value }]"
          :aria-pressed="verdict === v.value"
          @click="verdict = verdict === v.value ? null : v.value"
        >
          {{ v.label }}
        </button>
      </div>
      <PrimeTextarea
        v-model="text"
        rows="2"
        auto-resize
        class="oq-box"
        :placeholder="kind === 'about' ? 'In your own words: what you have done with it, where, and what you have not.' : 'What they told you, or what you found.'"
        :aria-label="`Answer: ${q.question}`"
      />
      <div class="oq-foot">
        <PrimeButton label="Save" size="small" :loading="busy" :disabled="!canSave || !dirty" @click="save" />
        <button v-if="q.answeredAt" type="button" class="linkish oq-link" @click="cancel">Cancel</button>
        <button v-else-if="kind === 'employer' || !askers.length" type="button" class="linkish oq-link" :class="{ danger: armed }" :disabled="busy" @click="remove">
          {{ armed ? 'Press again to remove' : 'Not a real question' }}
        </button>
        <span v-if="dirty" class="oq-draft">
          {{ restored ? 'Unsaved draft, restored.' : 'Not saved yet.' }}
          <button type="button" class="linkish oq-link" @click="discard">Discard</button>
        </span>
        <span v-else-if="kind === 'about'" class="oq-scope">Applies to every posting.</span>
      </div>
    </template>

    <p v-if="note" class="oq-note" :class="{ 'is-error': note.error }" role="status">{{ note.text }}</p>

    <p v-if="!bare && kind === 'about' && askers.length" class="oq-askers">
      Asked by
      <template v-for="(a, i) in askers.slice(0, 4)" :key="a.postingId">
        <NuxtLink :to="`/postings/${a.postingId}`">{{ a.company }}</NuxtLink><template v-if="i < Math.min(askers.length, 4) - 1">, </template>
      </template>
      <template v-if="askers.length > 4"> and {{ askers.length - 4 }} more</template>
    </p>
    <p v-if="!bare && employer" class="oq-askers">
      <NuxtLink :to="`/postings/${employer.postingId}`">{{ employer.company }}<template v-if="employer.role"> · {{ employer.role }}</template></NuxtLink>
    </p>
  </div>
</template>

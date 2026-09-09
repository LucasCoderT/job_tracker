<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import type { Answer } from '../../shared/types'
import { parseBeats, beatsToLines, splitList, slugify, lintAnswer, cleanAnswer } from '#shared/bank'

// One card, in the same line format the Notion columns and the app's editor
// use: cues one per line, beats as `text [STANCE] :: key, key`. The authoring
// rules from the interview-bank skill are the placeholders, so they are read
// at the moment they matter. Nothing here writes an answer — it is a place
// to type his own.
const props = defineProps<{ visible: boolean; answer: Answer | null; saving: boolean; error: string }>()
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void; (e: 'save', answer: Answer): void }>()

const question = ref('')
const id = ref('')
const idTouched = ref(false)
const cues = ref('')
const beats = ref('')
const script = ref('')
const avoid = ref('')
const floor = ref<number | null>(null)

watch(
  () => [props.visible, props.answer] as const,
  () => {
    if (!props.visible) return
    const a = props.answer
    question.value = a?.question ?? ''
    id.value = a?.id ?? ''
    idTouched.value = !!a
    cues.value = (a?.cues ?? []).join('\n')
    beats.value = beatsToLines(a?.beats ?? [])
    script.value = a?.script ?? ''
    avoid.value = (a?.avoid ?? []).join(', ')
    floor.value = a?.minSeconds ?? null
  },
  { immediate: true },
)

watch(question, (q) => {
  if (!idTouched.value) id.value = slugify(q, 40)
})

const draft = computed<Answer | null>(() => {
  try {
    return cleanAnswer({
      id: id.value,
      question: question.value,
      cues: splitList(cues.value),
      beats: parseBeats(beats.value),
      script: script.value,
      avoid: splitList(avoid.value),
      minSeconds: floor.value,
    })
  } catch {
    return null
  }
})
const preview = computed(() => (draft.value ? lintAnswer(draft.value) : []))

function close() {
  emit('update:visible', false)
}
function save() {
  if (draft.value) emit('save', draft.value)
}
</script>

<template>
  <PrimeDialog
    :visible="visible"
    modal
    :header="answer ? 'Edit card' : 'New card'"
    :style="{ width: 'min(760px, 96vw)' }"
    :draggable="false"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="editor">
      <label>
        <span>Question — how you would recognise it</span>
        <PrimeInputText v-model="question" autocomplete="off" />
      </label>
      <label>
        <span>Id <small class="mono">{{ id || '—' }}</small></span>
        <PrimeInputText v-model="id" class="mono" autocomplete="off" @input="idTouched = true" />
      </label>
      <label>
        <span>Cues — what the interviewer might say, one per line. Read like a spoken question: "why not just use JWTs".</span>
        <PrimeTextarea v-model="cues" auto-resize rows="3" />
      </label>
      <label>
        <span>Beats — one per line: <code>text [STANCE] :: key, key</code>. Under 8 words; keys are the words you actually say; six at most.</span>
        <PrimeTextarea v-model="beats" auto-resize rows="5" class="mono" placeholder="Rolled back first, debugged second [DELIBERATE] :: rolled back, revert" />
      </label>
      <label>
        <span>Script — the full answer, in your words. Shown under the question on the card.</span>
        <PrimeTextarea v-model="script" auto-resize rows="6" />
      </label>
      <div class="two">
        <label>
          <span>Never say on this card (comma-separated)</span>
          <PrimeInputText v-model="avoid" autocomplete="off" />
        </label>
        <label>
          <span>Floor — seconds an open invitation runs before the card may collapse</span>
          <PrimeInputNumber v-model="floor" :min="0" :max="900" show-buttons :step="15" />
        </label>
      </div>
      <ul v-if="preview.length" class="lint-preview">
        <li v-for="(issue, i) in preview" :key="i">{{ issue }}</li>
      </ul>
      <PrimeMessage v-if="error" severity="error" :closable="false">{{ error }}</PrimeMessage>
    </div>
    <template #footer>
      <PrimeButton label="Cancel" severity="secondary" text @click="close" />
      <PrimeButton :label="saving ? 'Saving…' : 'Save'" :disabled="!draft || saving" :loading="saving" @click="save" />
    </template>
  </PrimeDialog>
</template>

<script setup lang="ts">
/**
 * Every question an evaluation could not settle, in one list.
 *
 * Answering here is how the evaluations learn: career-ops reads these answers
 * before it scores a posting or builds a pack, so a question answered once is
 * not asked again. Unanswered ones are ordered by how many postings are
 * waiting on them, because that is the order they are worth answering in.
 */
import type { EmployerQuestion, FactsDoc, ProfileQuestion } from '../../shared/types'

const { data, pending, error } = await useFetch<FactsDoc>('/api/facts', { key: 'facts' })
useHead({ title: 'Questions for you' })

const about = computed(() => data.value?.about ?? [])
const employer = computed(() => data.value?.employer ?? [])

const toAnswer = computed(() =>
  about.value.filter((q) => !q.answeredAt).sort((a, b) => b.askedBy.length - a.askedBy.length || a.topic.localeCompare(b.topic)),
)
const answered = computed(() =>
  about.value.filter((q) => q.answeredAt).sort((a, b) => (b.answeredAt ?? '').localeCompare(a.answeredAt ?? '')),
)
const employerOpen = computed(() => employer.value.filter((q) => !q.answeredAt))
const employerDone = computed(() => employer.value.filter((q) => q.answeredAt))

// useFetch data is a shallow ref: replace the document, never edit a row in place.
function put(kind: 'about' | 'employer', q: ProfileQuestion | EmployerQuestion) {
  if (!data.value) return
  const list = (data.value[kind] as any[]).map((x) => (x.id === q.id ? q : x))
  data.value = { ...data.value, [kind]: list.some((x) => x.id === q.id) ? list : [...list, q] }
}
function drop(kind: 'about' | 'employer', id: string) {
  if (!data.value) return
  data.value = { ...data.value, [kind]: (data.value[kind] as any[]).filter((x) => x.id !== id) }
}

// ---- something no evaluation has asked ----
const addTopic = ref('')
const addAnswer = ref('')
const adding = ref(false)
const addNote = ref<{ text: string; error: boolean } | null>(null)
async function add() {
  if (adding.value) return
  adding.value = true
  addNote.value = null
  try {
    const q = await $fetch<ProfileQuestion>('/api/facts/about', { method: 'POST', body: { topic: addTopic.value, answer: addAnswer.value } })
    put('about', q)
    addTopic.value = ''
    addAnswer.value = ''
    addNote.value = { text: `Saved under “${q.topic}”.`, error: false }
  } catch (err: any) {
    addNote.value = { text: err?.data?.statusMessage || 'Could not save.', error: true }
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <div class="postings-page about-page">
    <header>
      <div>
        <NuxtLink to="/postings" class="crumb"><i class="pi pi-arrow-left" /> Postings</NuxtLink>
        <h1>Questions for you<span v-if="toAnswer.length" class="count mono">{{ toAnswer.length }}</span></h1>
      </div>
    </header>

    <p class="about-lede">
      What the evaluations could not tell from your CV. Answer one here and every later evaluation, CV and cover letter
      reads it, so it is not asked again. A CV or letter may repeat only what you wrote, so write it the way you would
      say it.
    </p>

    <div v-if="pending" class="skel" aria-busy="true" aria-label="Loading questions">
      <div class="skel-panel sk" style="height: 320px" />
    </div>
    <PrimeMessage v-else-if="error" severity="error" :closable="false">Could not load the questions.</PrimeMessage>

    <template v-else>
      <PrimeCard class="sec">
        <template #content>
          <h2>To answer <span class="mono">· {{ toAnswer.length }}</span></h2>
          <p v-if="!toAnswer.length" class="muted small" style="margin: 10px 0 0">
            Nothing is waiting. New questions appear here when an evaluation raises one.
          </p>
          <div v-else class="oq-list">
            <OpenQuestionRow v-for="q in toAnswer" :key="q.id" kind="about" :q="q" @saved="put('about', $event)" @removed="drop('about', $event)" />
          </div>
        </template>
      </PrimeCard>

      <PrimeCard v-if="employerOpen.length" class="sec">
        <template #content>
          <h2>To find out from employers <span class="mono">· {{ employerOpen.length }}</span></h2>
          <div class="oq-list">
            <OpenQuestionRow v-for="q in employerOpen" :key="q.id" kind="employer" :q="q" @saved="put('employer', $event)" @removed="drop('employer', $event)" />
          </div>
        </template>
      </PrimeCard>

      <PrimeCard class="sec">
        <template #content>
          <h2>Add something no evaluation has asked</h2>
          <div class="about-add">
            <PrimeInputText v-model="addTopic" placeholder="Topic, a few words: Kubernetes, On-call, Team lead" size="small" aria-label="Topic" />
            <PrimeTextarea v-model="addAnswer" rows="2" auto-resize placeholder="What is true about it, in your own words." aria-label="What is true about it" />
            <div class="oq-foot">
              <PrimeButton label="Add" size="small" :loading="adding" :disabled="!addTopic.trim() || !addAnswer.trim()" @click="add" />
              <span v-if="addNote" class="oq-note" :class="{ 'is-error': addNote.error }" role="status" style="margin: 0">{{ addNote.text }}</span>
            </div>
          </div>
        </template>
      </PrimeCard>

      <PrimeCard v-if="answered.length || employerDone.length" class="sec">
        <template #content>
          <h2>Answered <span class="mono">· {{ answered.length + employerDone.length }}</span></h2>
          <div class="oq-list">
            <OpenQuestionRow v-for="q in answered" :key="q.id" kind="about" :q="q" @saved="put('about', $event)" @removed="drop('about', $event)" />
            <OpenQuestionRow v-for="q in employerDone" :key="q.id" kind="employer" :q="q" @saved="put('employer', $event)" @removed="drop('employer', $event)" />
          </div>
        </template>
      </PrimeCard>
    </template>
  </div>
</template>

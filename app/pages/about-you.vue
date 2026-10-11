<script setup lang="ts">
/**
 * Every question an evaluation could not settle, in one list.
 *
 * Answering here is how the evaluations learn: career-ops reads these answers
 * before it scores a posting or builds a pack, so a question answered once is
 * not asked again. Unanswered ones are ordered by how many postings are
 * waiting on them, because that is the order they are worth answering in.
 */
import type { EmployerQuestion, FactsDoc, PostingsResponse, ProfileQuestion } from '../../shared/types'

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

// Employer questions are grouped by where the posting stands, because that is
// what decides when one can be asked: before applying it is a reason to hold
// off, after applying it is something for the first call. The listing is one
// index read. Awaited directly, not through usePostings(), which is not
// awaitable (see CLAUDE.md).
const { data: listing } = await useFetch<PostingsResponse>('/api/postings', { key: 'postings' })
const postingById = computed(() => new Map((listing.value?.postings ?? []).map((p) => [p.id, p])))
const EMPLOYER_GROUPS = [
  { key: 'open', label: 'Not applied yet', hint: 'Worth knowing before you apply.' },
  { key: 'applied', label: 'Applied', hint: 'To ask on the first call.' },
  { key: 'gone', label: 'Dismissed or closed', hint: '' },
] as const
function employerGroup(q: EmployerQuestion): (typeof EMPLOYER_GROUPS)[number]['key'] {
  const p = postingById.value.get(q.postingId)
  // A posting the site no longer holds cannot be acted on either.
  if (!p || p.state === 'dismissed' || p.closedAt) return 'gone'
  return p.state === 'applied' ? 'applied' : 'open'
}
const employerGroups = computed(() =>
  EMPLOYER_GROUPS.map((g) => ({
    ...g,
    rows: employerOpen.value.filter((q) => employerGroup(q) === g.key).sort((a, b) => a.company.localeCompare(b.company)),
  })).filter((g) => g.rows.length),
)
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

const bulk = provideOpenQuestionBulk()

// Two tabs, one kind each. On one page under one title ("Questions for you")
// the employer's questions read as his to answer.
const tab = ref<'about' | 'employer'>('about')
const TABS = computed(() => [
  { key: 'about' as const, label: 'About you', n: toAnswer.value.length, unit: 'to answer' },
  { key: 'employer' as const, label: 'To ask employers', n: employerOpen.value.length, unit: 'open' },
])

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

    <nav class="about-tabs" aria-label="Kind of question">
      <button v-for="t in TABS" :key="t.key" type="button" class="about-tab" :class="{ on: tab === t.key }" :aria-pressed="tab === t.key" @click="tab = t.key">
        {{ t.label }}<span class="n mono">{{ t.n }} {{ t.unit }}</span>
      </button>
    </nav>

    <p v-if="tab === 'about'" class="about-lede">
      What the evaluations could not tell from your CV. Answer one here and every later evaluation, CV and cover letter
      reads it, so it is not asked again. A CV or letter may repeat only what you wrote, so write it the way you would
      say it.
    </p>
    <p v-else class="about-lede">
      Things only an employer can tell you: the real band, whether Alberta is eligible, how on-call runs. They are not
      yours to answer. When one of them does, record what they said against that posting.
    </p>

    <div v-if="pending && !data" class="skel" aria-busy="true" aria-label="Loading questions">
      <div class="skel-panel sk" style="height: 320px" />
    </div>
    <PrimeMessage v-else-if="error" severity="error" :closable="false">Could not load the questions.</PrimeMessage>

    <template v-else>
      <PrimeCard v-show="tab === 'about'" class="sec">
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

      <PrimeCard v-show="tab === 'employer'" class="sec">
        <template #content>
          <h2>To ask <span class="mono">· {{ employerOpen.length }}</span></h2>
          <p v-if="!employerOpen.length" class="muted small" style="margin: 10px 0 0">Nothing to ask anyone right now.</p>
          <template v-for="g in employerGroups" :key="g.key">
            <h3 class="oq-group">
              {{ g.label }} <span class="mono">· {{ g.rows.length }}</span>
              <span v-if="g.hint" class="oq-group-hint">{{ g.hint }}</span>
            </h3>
            <div class="oq-list employer">
              <OpenQuestionRow v-for="q in g.rows" :key="q.id" kind="employer" :q="q" @saved="put('employer', $event)" @removed="drop('employer', $event)" />
            </div>
          </template>
        </template>
      </PrimeCard>

      <PrimeCard v-show="tab === 'about'" class="sec">
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

      <PrimeCard v-if="answered.length" v-show="tab === 'about'" class="sec">
        <template #content>
          <h2>Answered <span class="mono">· {{ answered.length }}</span></h2>
          <div class="oq-list">
            <OpenQuestionRow v-for="q in answered" :key="q.id" kind="about" :q="q" @saved="put('about', $event)" @removed="drop('about', $event)" />
          </div>
        </template>
      </PrimeCard>

      <PrimeCard v-if="employerDone.length" v-show="tab === 'employer'" class="sec">
        <template #content>
          <h2>What they told you <span class="mono">· {{ employerDone.length }}</span></h2>
          <div class="oq-list employer">
            <OpenQuestionRow v-for="q in employerDone" :key="q.id" kind="employer" :q="q" @saved="put('employer', $event)" @removed="drop('employer', $event)" />
          </div>
        </template>
      </PrimeCard>

      <OpenQuestionSaveAll :count="bulk.count.value" :busy="bulk.busy.value" :note="bulk.note.value" @save="bulk.saveAll" />
    </template>
  </div>
</template>

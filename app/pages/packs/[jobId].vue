<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Answer, PackDetail, NotionWriteResult } from '../../../shared/types'
import { splitList } from '#shared/bank'

// One interview's pack: what the Mac built, what he can read on a phone, and
// the cards he can edit here. Every card save lands in KV (what the app
// imports) and is written back to the Notion answer bank (the record) —
// which is also what a regenerate is built from, so edits survive it.
const route = useRoute()
const jobId = computed(() => String(route.params.jobId))

const { data, pending, error, refresh } = await useFetch<PackDetail>(() => `/api/packs/${jobId.value}`, {
  key: () => `pack:${jobId.value}`,
})
const { refresh: refreshIndex } = usePacks()

const meta = computed(() => data.value?.meta)
const bank = computed(() => data.value?.bank ?? null)
const lintIssues = computed(() => data.value?.lint ?? [])
useHead({ title: () => (meta.value ? `${meta.value.company} — pack` : 'Pack') })

const deckIds = computed(() => new Set((bank.value?.presentation ?? []).map((s) => s.answerId)))
const cards = computed(() => {
  const answers = bank.value?.answers ?? []
  const deck = (bank.value?.presentation ?? [])
    .map((s, i) => ({ answer: answers.find((a) => a.id === s.answerId), lead: `${i + 1} · ${clock(s.budgetSeconds)}` }))
    .filter((c) => c.answer) as { answer: Answer; lead: string }[]
  const rest = answers.filter((a) => !deckIds.value.has(a.id)).map((answer) => ({ answer, lead: '' }))
  return [...deck, ...rest]
})

function clock(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
}
function kb(n: number) {
  return n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`
}

// ---- notices ----
const notice = ref<{ text: string; severity: 'success' | 'warn' | 'error' | 'info' } | null>(null)
function report(prefix: string, notion: NotionWriteResult | null) {
  if (!notion) return (notice.value = { text: `${prefix}.`, severity: 'success' })
  if (notion.ok) {
    const what = notion.created ? 'new row added to the answer bank' : notion.scope === 'universal'
      ? 'Notion row updated — a universal card, so this edit applies to every bank'
      : 'Notion row updated'
    notice.value = { text: `${prefix} · ${what}.`, severity: notion.scope === 'universal' ? 'info' : 'success' }
  } else {
    notice.value = { text: `${prefix} on the site · Notion not updated: ${notion.error}`, severity: 'warn' }
  }
}
function fail(err: any, what: string) {
  notice.value = { text: `${what}: ${err?.data?.statusMessage || err?.message || 'failed'}`, severity: 'error' }
}

// ---- request / regenerate ----
const note = ref('')
const requesting = ref(false)
async function request() {
  requesting.value = true
  try {
    await $fetch(`/api/packs/${jobId.value}/request`, { method: 'POST', body: { note: note.value || meta.value?.note } })
    notice.value = { text: 'Queued. The Mac builds it from Notion and uploads the result here.', severity: 'success' }
    await Promise.all([refresh(), refreshIndex()])
  } catch (err) {
    fail(err, "Couldn't queue")
  } finally {
    requesting.value = false
  }
}

// ---- two-step deletes (the app's own convention: arm, then confirm) ----
const armed = ref<string | null>(null)
let disarm: ReturnType<typeof setTimeout> | undefined
function arm(key: string) {
  armed.value = key
  clearTimeout(disarm)
  disarm = setTimeout(() => (armed.value = null), 4000)
}
async function deletePack() {
  if (armed.value !== 'pack') return arm('pack')
  try {
    await $fetch(`/api/packs/${jobId.value}`, { method: 'DELETE' })
    await refreshIndex()
    await navigateTo('/packs')
  } catch (err) {
    fail(err, "Couldn't delete the pack")
  }
}
async function deleteExport(name: string) {
  if (armed.value !== `export:${name}`) return arm(`export:${name}`)
  try {
    await $fetch(`/api/packs/${jobId.value}/exports/${encodeURIComponent(name)}`, { method: 'DELETE' })
    await refresh()
  } catch (err) {
    fail(err, "Couldn't delete the export")
  }
}
async function deleteCard(answer: Answer) {
  if (armed.value !== `card:${answer.id}`) return arm(`card:${answer.id}`)
  try {
    const res = await $fetch<PackDetail & { notion: NotionWriteResult | null }>(
      `/api/packs/${jobId.value}/answers/${encodeURIComponent(answer.id)}`,
      { method: 'DELETE' },
    )
    report(`Removed “${answer.question}”`, res.notion && res.notion.ok && res.notion.scope === 'universal'
      ? { ...res.notion, created: false }
      : res.notion)
    if (res.notion?.ok && res.notion.scope === 'universal') {
      notice.value = { text: `Removed from this pack. Its Notion row is universal, so it was left active.`, severity: 'info' }
    } else if (res.notion?.ok) {
      notice.value = { text: `Removed from this pack · Notion row unticked (kept for the record).`, severity: 'success' }
    }
    await refresh()
  } catch (err) {
    fail(err, "Couldn't remove the card")
  }
}

// ---- card editor ----
const editing = ref(false)
const editingAnswer = ref<Answer | null>(null)
const saving = ref(false)
const saveError = ref('')
function edit(answer: Answer | null) {
  editingAnswer.value = answer
  saveError.value = ''
  editing.value = true
}
async function save(answer: Answer) {
  saving.value = true
  saveError.value = ''
  const routeId = editingAnswer.value?.id ?? answer.id
  try {
    const res = await $fetch<PackDetail & { notion: NotionWriteResult | null }>(
      `/api/packs/${jobId.value}/answers/${encodeURIComponent(routeId)}`,
      { method: 'PUT', body: { answer } },
    )
    editing.value = false
    report(`Saved “${answer.question}”`, res.notion)
    await Promise.all([refresh(), refreshIndex()])
  } catch (err: any) {
    saveError.value = err?.data?.statusMessage || err?.message || 'Save failed'
  } finally {
    saving.value = false
  }
}

// ---- bank-level details (title, never-say) ----
const bankTitle = ref('')
const bankAvoid = ref('')
const detailsOpen = ref(false)
function openDetails() {
  bankTitle.value = bank.value?.title ?? ''
  bankAvoid.value = (bank.value?.avoid ?? []).join(', ')
  detailsOpen.value = true
}
async function saveDetails() {
  const current = bank.value ?? { answers: [] }
  const next = { ...current, title: bankTitle.value.trim() || undefined, avoid: splitList(bankAvoid.value) }
  if (!next.avoid.length) delete (next as any).avoid
  try {
    await $fetch(`/api/packs/${jobId.value}/bank`, { method: 'PUT', body: next })
    detailsOpen.value = false
    notice.value = { text: 'Bank details saved (site only — the title and never-say list are not Notion columns).', severity: 'success' }
    await refresh()
  } catch (err) {
    fail(err, "Couldn't save")
  }
}
</script>

<template>
  <div class="packs-page pack-detail">
    <header>
      <div>
        <NuxtLink to="/packs" class="crumb"><i class="pi pi-arrow-left" /> Packs</NuxtLink>
        <h1 v-if="meta">{{ meta.company }}<span v-if="meta.position" class="pos"> · {{ meta.position }}</span></h1>
        <h1 v-else>Pack</h1>
      </div>
    </header>

    <div v-if="pending" class="state"><PrimeProgressSpinner style="width: 44px; height: 44px" stroke-width="4" /></div>
    <PrimeMessage v-else-if="error" severity="error" :closable="false">
      {{ error.statusCode === 404 ? 'No pack for this job yet — queue one from the tracker.' : error.message }}
    </PrimeMessage>

    <template v-else-if="meta">
      <PrimeMessage v-if="notice" :severity="notice.severity" @close="notice = null">{{ notice.text }}</PrimeMessage>

      <PrimeCard class="sec">
        <template #content>
          <div class="pack-head">
            <PrimeTag :value="PACK_STATUS_LABEL[meta.status] || meta.status" :severity="packSeverity(meta.status)" />
            <span class="mono muted">{{ meta.answers }} cards · {{ meta.beats }} beats · slug <b>{{ meta.slug }}</b></span>
            <ClientOnly>
              <span class="mono muted">requested {{ when(meta.requestedAt) }}<template v-if="meta.builtAt"> · built {{ when(meta.builtAt) }}</template></span>
            </ClientOnly>
          </div>
          <p v-if="meta.status === 'failed' && meta.error" class="pack-error mono">{{ meta.error }}</p>
          <p v-if="meta.note" class="pack-note">“{{ meta.note }}”</p>
          <p v-if="meta.status === 'requested' || meta.status === 'building'" class="muted small">
            Waiting for the Mac. It builds the bank from Notion with career-ops and uploads it here; you can add cards by hand meanwhile.
          </p>
          <div class="pack-actions">
            <PrimeInputText v-model="note" :placeholder="meta.note || 'Note for the build (round, panel, focus)…'" size="small" class="note" />
            <PrimeButton
              :label="meta.status === 'done' || meta.status === 'failed' ? 'Regenerate' : 'Re-queue'"
              icon="pi pi-refresh"
              size="small"
              :loading="requesting"
              @click="request"
            />
            <PrimeButton label="Bank details" icon="pi pi-pencil" size="small" severity="secondary" outlined @click="openDetails" />
            <PrimeButton
              :label="armed === 'pack' ? 'Really delete?' : 'Delete pack'"
              icon="pi pi-trash"
              size="small"
              :severity="armed === 'pack' ? 'danger' : 'secondary'"
              text
              @click="deletePack"
            />
          </div>
        </template>
      </PrimeCard>

      <PrimeCard class="sec">
        <template #content>
          <h2>Read anywhere</h2>
          <div class="exports">
            <a v-if="bank" class="export" :href="`/api/packs/${jobId}/prep.html`" target="_blank" rel="noopener">
              <i class="pi pi-file" /> <span class="name">Prep sheet</span> <span class="mono muted">every card, printable</span>
            </a>
            <a v-if="bank" class="export" :href="`/api/packs/${jobId}/bank.json`" target="_blank" rel="noopener">
              <i class="pi pi-download" /> <span class="name mono">{{ meta.slug }}.json</span> <span class="mono muted">what the app imports</span>
            </a>
            <div v-for="e in meta.exports" :key="e.name" class="export">
              <a :href="`/api/packs/${jobId}/exports/${encodeURIComponent(e.name)}`" target="_blank" rel="noopener">
                <i class="pi pi-file-edit" /> <span class="name mono">{{ e.name }}</span>
              </a>
              <span class="mono muted">{{ kb(e.bytes) }}</span>
              <button type="button" class="linkish" :class="{ danger: armed === `export:${e.name}` }" @click="deleteExport(e.name)">
                {{ armed === `export:${e.name}` ? 'really?' : 'delete' }}
              </button>
            </div>
            <p v-if="!bank && !meta.exports.length" class="muted small">Nothing published yet.</p>
          </div>
        </template>
      </PrimeCard>

      <PrimeMessage v-if="lintIssues.length" severity="warn" :closable="false">
        <b>Lint — {{ lintIssues.length }}</b>
        <ul class="lint">
          <li v-for="(issue, i) in lintIssues" :key="i">{{ issue }}</li>
        </ul>
      </PrimeMessage>

      <PrimeCard class="sec">
        <template #content>
          <div class="cards-head">
            <h2>Cards<span v-if="bank?.title" class="muted"> · {{ bank.title }}</span></h2>
            <PrimeButton label="Add card" icon="pi pi-plus" size="small" @click="edit(null)" />
          </div>
          <p v-if="!cards.length" class="muted small">No cards yet.</p>
          <article v-for="{ answer, lead } in cards" :key="answer.id" class="pack-card">
            <div class="pack-card-head">
              <div>
                <h3>{{ answer.question }}</h3>
                <p class="mono muted small">
                  <span v-if="lead" class="lead">deck {{ lead }} · </span>{{ answer.id }}<span v-if="answer.minSeconds"> · floor {{ clock(answer.minSeconds) }}</span>
                </p>
              </div>
              <div class="pack-card-tools">
                <PrimeButton icon="pi pi-pencil" size="small" text severity="secondary" aria-label="Edit" @click="edit(answer)" />
                <PrimeButton
                  :icon="armed === `card:${answer.id}` ? 'pi pi-exclamation-triangle' : 'pi pi-trash'"
                  size="small"
                  text
                  :severity="armed === `card:${answer.id}` ? 'danger' : 'secondary'"
                  :aria-label="armed === `card:${answer.id}` ? 'Really remove?' : 'Remove'"
                  @click="deleteCard(answer)"
                />
              </div>
            </div>
            <div v-if="answer.cues.length" class="cues">
              <span v-for="c in answer.cues" :key="c" class="cue">{{ c }}</span>
            </div>
            <ul class="beats">
              <li v-for="(b, i) in answer.beats" :key="i">
                <span class="dot" /><span class="text">{{ b.text }}</span>
                <span v-if="b.stance" class="stance">{{ b.stance }}</span>
                <span class="keys mono">{{ b.keys.join(', ') }}</span>
              </li>
            </ul>
            <details v-if="answer.script" class="script">
              <summary>Script</summary>
              <p>{{ answer.script }}</p>
            </details>
            <p v-if="answer.avoid?.length" class="avoid">never say: {{ answer.avoid.join(' · ') }}</p>
          </article>
        </template>
      </PrimeCard>

      <PackCardEditor v-model:visible="editing" :answer="editingAnswer" :saving="saving" :error="saveError" @save="save" />

      <PrimeDialog v-model:visible="detailsOpen" modal header="Bank details" :style="{ width: 'min(560px, 96vw)' }" :draggable="false">
        <div class="editor">
          <label><span>Title (what the app's picker shows)</span><PrimeInputText v-model="bankTitle" /></label>
          <label><span>Never say, bank-wide (comma-separated)</span><PrimeInputText v-model="bankAvoid" /></label>
        </div>
        <template #footer>
          <PrimeButton label="Cancel" severity="secondary" text @click="detailsOpen = false" />
          <PrimeButton label="Save" @click="saveDetails" />
        </template>
      </PrimeDialog>
    </template>
  </div>
</template>

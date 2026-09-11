<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Answer, PackDetail, NotionWriteResult, PostingsResponse } from '../../../shared/types'
import { splitList } from '#shared/bank'

// One interview's pack: what the Mac built, what he can read on a phone, and
// the cards he can edit here. Every card save lands in KV (what the app
// imports) and is written back to the Notion answer bank (the record) —
// which is also what a regenerate is built from, so edits survive it.
//
// Two columns: the deck is the page, and everything about the build — status,
// files, lint, the posting it came from — sits on a rail beside it. Reading a
// card and checking whether the build is current are different jobs; stacking
// them put the answers he is trying to learn below three panels of plumbing.
const route = useRoute()
const jobId = computed(() => String(route.params.jobId))

const { data, pending, error, refresh } = await useFetch<PackDetail>(() => `/api/packs/${jobId.value}`, {
  key: () => `pack:${jobId.value}`,
})
const { refresh: refreshIndex } = usePacks()

// The tracker and the postings list, for the one link back out: which
// conversation this pack is for, and the brief it was scored from.
const { data: stats } = await useStats()
const { data: postingsData } = await useFetch<PostingsResponse>('/api/postings', { key: 'postings' })

const meta = computed(() => data.value?.meta)
const bank = computed(() => data.value?.bank ?? null)
const lintIssues = computed(() => data.value?.lint ?? [])
useHead({ title: () => (meta.value ? `${meta.value.company} — pack` : 'Pack') })

const STATUS_LABEL: Record<string, string> = {
  requested: 'Requested',
  building: 'Building…',
  done: 'Ready',
  failed: 'Failed',
}
const STATUS_ICON: Record<string, string> = {
  requested: 'pi pi-clock',
  building: 'pi pi-spin pi-spinner',
  done: 'pi pi-check-circle',
  failed: 'pi pi-exclamation-triangle',
}
const inFlight = computed(() => meta.value?.status === 'requested' || meta.value?.status === 'building')

// ---- the deck ----
const deck = computed(() => bank.value?.presentation ?? [])
const answers = computed(() => bank.value?.answers ?? [])
const beatCount = computed(() => answers.value.reduce((t, a) => t + a.beats.length, 0))
const budget = computed(() => deck.value.reduce((t, s) => t + s.budgetSeconds, 0))

/**
 * The deck first in its running order, then whatever is not in it. A card
 * outside the deck is not spare — it is what he falls back on when they ask
 * something the deck did not plan for, so it is labelled, not hidden.
 */
const cards = computed(() => {
  const hasDeck = deck.value.length > 0
  const inDeck = deck.value
    .map((s, i) => {
      const answer = answers.value.find((a) => a.id === s.answerId)
      return answer ? { answer, lead: `${i + 1} · ${clock(s.budgetSeconds)}`, reserve: false } : null
    })
    .filter(Boolean) as { answer: Answer; lead: string; reserve: boolean }[]
  const seen = new Set(inDeck.map((c) => c.answer.id))
  const rest = answers.value
    .filter((a) => !seen.has(a.id))
    .map((answer) => ({ answer, lead: hasDeck ? 'reserve' : '', reserve: true }))
  return [...inDeck, ...rest]
})

const deckSummary = computed(() => {
  const parts: string[] = []
  if (deck.value.length) parts.push(`${deck.value.length} in deck`)
  parts.push(plural(answers.value.length, 'card'), plural(beatCount.value, 'beat'))
  return parts.join(' · ')
})

const deckHint = computed(() => {
  if (!bank.value) return ''
  const reserve = answers.value.length - deck.value.length
  if (!deck.value.length) return 'No running order yet — every card is reached by its cues or from the picker.'
  if (!reserve) return `The deck runs ${clock(budget.value)} at budget.`
  return `The deck runs ${clock(budget.value)} at budget; the other ${reserve} sit in reserve for whatever they actually ask.`
})

const STANCE_CLASS: Record<string, string> = {
  DELIBERATE: 'st-deliberate',
  MEASURED: 'st-measured',
  GAP: 'st-gap',
  UNMEASURED: 'st-unmeasured',
}

// ---- the rail ----
const files = computed(() => {
  const m = meta.value
  if (!m) return []
  const out: {
    key: string
    label: string
    sub: string
    icon: string
    go: string
    href: string
    mono: boolean
    name?: string
  }[] = []
  if (bank.value) {
    out.push({
      key: 'prep',
      label: 'Prep sheet',
      sub: 'every card, printable',
      icon: 'pi pi-file',
      go: 'pi pi-external-link',
      href: `/api/packs/${jobId.value}/prep.html`,
      mono: false,
    })
    out.push({
      key: 'bank',
      label: `${m.slug}.json`,
      sub: 'what the app imports',
      icon: 'pi pi-download',
      go: 'pi pi-download',
      href: `/api/packs/${jobId.value}/bank.json`,
      mono: true,
    })
  }
  for (const e of m.exports) {
    out.push({
      key: `export:${e.name}`,
      label: e.name,
      sub: `export · ${kb(e.bytes)}`,
      icon: 'pi pi-file-edit',
      go: 'pi pi-download',
      href: `/api/packs/${jobId.value}/exports/${encodeURIComponent(e.name)}`,
      mono: true,
      name: e.name,
    })
  }
  return out
})

/** `[card-id] the problem` — the id carries, so it is coloured, not buried. */
const lintRows = computed(() =>
  lintIssues.value.map((t) => {
    const m = /^\[([^\]]+)\]\s*(.*)$/.exec(t)
    return m ? { id: m[1]!, text: m[2]! } : { id: '', text: t }
  }),
)

const job = computed(() => (stats.value?.jobs ?? []).find((j) => j.id === jobId.value) ?? null)
const posting = computed(() => (postingsData.value?.postings ?? []).find((p) => p.notionPageId === jobId.value) ?? null)
const postingSub = computed(() => {
  const j = job.value
  if (!j) return posting.value?.source ?? ''
  return [j.stage || 'no interview yet', j.source, j.ageDays != null ? `${j.ageDays}d old` : '']
    .filter(Boolean)
    .join(' · ')
})

// ---- presentation ----
function clock(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
}
function kb(n: number) {
  return n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`
}
function plural(n: number, one: string, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`
}
function words(s: string) {
  const t = s.trim()
  return t ? plural(t.split(/\s+/).length, 'word') : ''
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

// ---- rebuild ----
const note = ref('')
const rebuildOpen = ref(false)
const requesting = ref(false)
async function request() {
  requesting.value = true
  try {
    await $fetch(`/api/packs/${jobId.value}/request`, { method: 'POST', body: { note: note.value || meta.value?.note } })
    rebuildOpen.value = false
    note.value = ''
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

// The pack itself gets a dialog rather than the two-step: it is the one action
// here that cannot be undone from the site, and it is worth saying what goes.
const deleteOpen = ref(false)
const deleteDetail = computed(() => {
  const m = meta.value
  if (!m || m.status !== 'done') return 'nothing has been built yet'
  return [plural(answers.value.length, 'card'), plural(beatCount.value, 'beat'), plural(m.exports.length, 'exported file')].join(', ')
})
async function deletePack() {
  try {
    await $fetch(`/api/packs/${jobId.value}`, { method: 'DELETE' })
    await refreshIndex()
    await navigateTo('/packs')
  } catch (err) {
    deleteOpen.value = false
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
    if (res.notion?.ok && res.notion.scope === 'universal') {
      notice.value = { text: 'Removed from this pack. Its Notion row is universal, so it was left active.', severity: 'info' }
    } else if (res.notion?.ok) {
      notice.value = { text: `Removed “${answer.question}” · Notion row unticked (kept for the record).`, severity: 'success' }
    } else {
      report(`Removed “${answer.question}”`, res.notion)
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
      <div v-if="meta" class="header-tools">
        <PrimeButton
          v-if="bank"
          as="a"
          :href="`/api/packs/${jobId}/prep.html`"
          target="_blank"
          rel="noopener"
          label="Prep sheet"
          icon="pi pi-file"
          severity="secondary"
          outlined
          size="small"
        />
        <PrimeButton label="Add card" icon="pi pi-plus" size="small" @click="edit(null)" />
      </div>
    </header>

    <div v-if="pending" class="skel pack-grid" aria-busy="true" aria-label="Loading pack">
      <div class="skel-panel sk" style="height: 520px" />
      <div class="skel-panel sk" style="height: 300px; animation-delay: 120ms" />
    </div>

    <PrimeMessage v-else-if="error" severity="error" :closable="false">
      {{ error.statusCode === 404 ? 'No pack for this job yet — queue one from the tracker.' : error.message }}
    </PrimeMessage>

    <template v-else-if="meta">
      <PrimeMessage v-if="notice" :severity="notice.severity" @close="notice = null">{{ notice.text }}</PrimeMessage>

      <div class="pack-grid">
        <!-- The deck itself: the reason the page exists. -->
        <PrimeCard class="sec deck" aria-label="Cards">
          <template #content>
            <div class="deck-head">
              <h2>Deck<span v-if="bank?.title" class="mono faint"> {{ bank.title }}</span></h2>
              <span class="mono faint deck-sum">{{ deckSummary }}</span>
            </div>
            <p v-if="deckHint" class="deck-hint">{{ deckHint }}</p>
            <p v-if="!cards.length" class="muted small">
              {{ inFlight ? 'The Mac is building it from Notion — the cards land here when it is done.' : 'No cards yet. Add one, or queue a build.' }}
            </p>

            <article v-for="{ answer, lead, reserve } in cards" :key="answer.id" class="pack-card">
              <div class="pack-card-head">
                <div class="pack-card-id">
                  <p v-if="lead" class="lead mono" :class="{ reserve }">{{ lead }}</p>
                  <h3>{{ answer.question }}</h3>
                  <p class="mono faint small slug">
                    {{ answer.id }}<span v-if="answer.minSeconds"> · floor {{ clock(answer.minSeconds) }}</span>
                  </p>
                </div>
                <div class="pack-card-tools">
                  <button type="button" class="icon-btn" :aria-label="`Edit ${answer.question}`" @click="edit(answer)">
                    <i class="pi pi-pencil" />
                  </button>
                  <button
                    type="button"
                    class="icon-btn danger"
                    :class="{ armed: armed === `card:${answer.id}` }"
                    :aria-label="armed === `card:${answer.id}` ? `Really remove ${answer.question}?` : `Remove ${answer.question}`"
                    :title="armed === `card:${answer.id}` ? 'Really remove?' : 'Remove'"
                    @click="deleteCard(answer)"
                  >
                    <i :class="armed === `card:${answer.id}` ? 'pi pi-exclamation-triangle' : 'pi pi-trash'" />
                  </button>
                </div>
              </div>

              <!-- A table, not a list: the beat, its stance and the words that
                   tick it are three columns he scans down, not a wrapped run. -->
              <table v-if="answer.beats.length" class="beats-table">
                <tbody>
                  <tr v-for="(b, i) in answer.beats" :key="i">
                    <td class="beat-text"><span class="dot" />{{ b.text }}</td>
                    <td class="beat-stance" :class="(b.stance && STANCE_CLASS[b.stance]) || ''">{{ b.stance }}</td>
                    <td class="beat-keys mono">{{ b.keys.join(', ') }}</td>
                  </tr>
                </tbody>
              </table>

              <div v-if="answer.cues.length" class="cues">
                <span v-for="c in answer.cues" :key="c" class="cue">{{ c }}</span>
              </div>
              <details v-if="answer.script" class="script">
                <summary class="mono">script · {{ words(answer.script) }}</summary>
                <p>{{ answer.script }}</p>
              </details>
              <p v-if="answer.avoid?.length" class="avoid mono">never say: {{ answer.avoid.join(' · ') }}</p>
            </article>
          </template>
        </PrimeCard>

        <!-- The rail: build state, what came out, and what is wrong with it. -->
        <aside class="pack-rail">
          <PrimeCard class="sec rail-next" aria-label="Build">
            <template #content>
              <div class="rail-head">
                <h2 class="rail-title">Build</h2>
                <span class="status-pill" :class="meta.status">
                  <i :class="STATUS_ICON[meta.status]" />{{ STATUS_LABEL[meta.status] || meta.status }}
                </span>
              </div>

              <dl class="facts-grid build-facts mono">
                <dt>slug</dt>
                <dd>{{ meta.slug }}</dd>
                <dt>requested</dt>
                <dd><ClientOnly>{{ when(meta.requestedAt) }}</ClientOnly></dd>
                <dt>built</dt>
                <dd><ClientOnly>{{ when(meta.builtAt) }}</ClientOnly></dd>
                <dt>updated</dt>
                <dd><ClientOnly>{{ when(meta.updatedAt) }}</ClientOnly></dd>
              </dl>

              <p v-if="meta.status === 'failed' && meta.error" class="pack-error mono">{{ meta.error }}</p>
              <p v-if="meta.note" class="rail-quote">“{{ meta.note }}”</p>
              <p v-if="inFlight" class="rail-hint">
                Waiting for the Mac. It builds the bank from Notion with career-ops and uploads it here; you can add
                cards by hand meanwhile.
              </p>

              <PrimeButton
                class="rail-primary"
                :label="inFlight ? 'Re-queue' : 'Rebuild'"
                :icon="requesting ? 'pi pi-spin pi-spinner' : 'pi pi-refresh'"
                :loading="requesting"
                @click="rebuildOpen = true"
              />
              <p class="rail-hint">
                Rebuilding replaces every card from Notion. Edits made here are written back first, so they survive —
                any the write-back refused will not.
              </p>

              <div class="rail-danger">
                <PrimeButton label="Bank details" icon="pi pi-pencil" size="small" severity="secondary" text @click="openDetails" />
                <PrimeButton
                  class="danger-btn"
                  label="Delete"
                  icon="pi pi-trash"
                  size="small"
                  severity="danger"
                  text
                  @click="deleteOpen = true"
                />
              </div>
            </template>
          </PrimeCard>

          <PrimeCard class="sec" aria-label="Files">
            <template #content>
              <div class="rail-head">
                <h2>Read anywhere</h2>
                <span class="mono faint">{{ files.length ? plural(files.length, 'file') : '' }}</span>
              </div>
              <div v-if="files.length" class="rail-files">
                <div v-for="f in files" :key="f.key" class="rail-file">
                  <a class="file-card" :href="f.href" target="_blank" rel="noopener">
                    <i :class="f.icon" />
                    <span class="file-meta">
                      <span class="file-label" :class="{ mono: f.mono }">{{ f.label }}</span>
                      <span class="file-sub mono">{{ f.sub }}</span>
                    </span>
                    <i :class="f.go + ' go'" />
                  </a>
                  <button
                    v-if="f.name"
                    type="button"
                    class="file-del"
                    :class="{ armed: armed === `export:${f.name}` }"
                    :aria-label="`Delete ${f.name}`"
                    :title="armed === `export:${f.name}` ? 'Really delete?' : 'Delete'"
                    @click="deleteExport(f.name)"
                  >
                    <i :class="armed === `export:${f.name}` ? 'pi pi-exclamation-triangle' : 'pi pi-trash'" />
                  </button>
                </div>
              </div>
              <p v-else class="muted small">Nothing published yet.</p>
            </template>
          </PrimeCard>

          <PrimeCard v-if="lintRows.length" class="sec rail-lint" aria-label="Lint">
            <template #content>
              <div class="rail-head">
                <h2 class="rail-title">Lint<span class="mono faint n">{{ lintRows.length }}</span></h2>
              </div>
              <ul class="lint-list">
                <li v-for="(l, i) in lintRows" :key="i" class="mono">
                  <span v-if="l.id" class="lint-id">{{ l.id }}</span> {{ l.text }}
                </li>
              </ul>
            </template>
          </PrimeCard>

          <NuxtLink v-if="posting" class="link-card" :to="`/postings/${posting.id}`">
            <span class="link-meta">
              <span class="link-title">The posting</span>
              <span v-if="postingSub" class="link-sub mono">{{ postingSub }}</span>
            </span>
            <i class="pi pi-angle-right go" />
          </NuxtLink>
          <a v-else-if="job?.url" class="link-card" :href="job.url" target="_blank" rel="noopener">
            <span class="link-meta">
              <span class="link-title">The posting</span>
              <span v-if="postingSub" class="link-sub mono">{{ postingSub }}</span>
            </span>
            <i class="pi pi-external-link go" />
          </a>
        </aside>
      </div>

      <PackCardEditor v-model:visible="editing" :answer="editingAnswer" :saving="saving" :error="saveError" @save="save" />

      <PrimeDialog v-model:visible="rebuildOpen" modal header="Rebuild the pack" :style="{ width: 'min(520px, 96vw)' }" :draggable="false">
        <div class="build-dialog">
          <p class="muted small">
            The Mac rebuilds every card from the Notion rows for this job and uploads the result here — usually a few
            minutes. A note steers which stories get the room.
          </p>
          <label>
            <span>Note for the build <small>optional</small></span>
            <PrimeTextarea v-model="note" rows="5" :placeholder="meta.note || 'Round, panel, what to emphasise…'" autocomplete="off" />
          </label>
          <p class="faint small mono">{{ meta.note ? `last build: “${meta.note}”` : 'no note on the last build' }}</p>
        </div>
        <template #footer>
          <PrimeButton label="Cancel" severity="secondary" text size="small" @click="rebuildOpen = false" />
          <PrimeButton :label="inFlight ? 'Re-queue' : 'Rebuild'" icon="pi pi-refresh" size="small" :loading="requesting" @click="request" />
        </template>
      </PrimeDialog>

      <PrimeDialog v-model:visible="detailsOpen" modal header="Bank details" :style="{ width: 'min(560px, 96vw)' }" :draggable="false">
        <div class="editor">
          <label><span>Title — what the app's picker shows</span><PrimeInputText v-model="bankTitle" autocomplete="off" /></label>
          <label><span>Never say, bank-wide (comma-separated)</span><PrimeInputText v-model="bankAvoid" autocomplete="off" /></label>
          <p class="faint small">Site only — neither field is a Notion column, so a rebuild keeps them.</p>
        </div>
        <template #footer>
          <PrimeButton label="Cancel" severity="secondary" text size="small" @click="detailsOpen = false" />
          <PrimeButton label="Save" size="small" @click="saveDetails" />
        </template>
      </PrimeDialog>

      <PrimeDialog v-model:visible="deleteOpen" modal header="Delete this pack?" :style="{ width: 'min(440px, 96vw)' }" :draggable="false">
        <div class="delete-dialog">
          <p>
            Removes the <b>{{ meta.company }}<template v-if="meta.position"> · {{ meta.position }}</template></b> pack —
            {{ deleteDetail }}.
          </p>
          <p class="muted">
            The Notion rows stay ticked and the application is untouched. You can queue another build whenever you want.
          </p>
        </div>
        <template #footer>
          <PrimeButton label="Cancel" severity="secondary" text size="small" @click="deleteOpen = false" />
          <PrimeButton label="Delete pack" icon="pi pi-trash" size="small" severity="danger" @click="deletePack" />
        </template>
      </PrimeDialog>
    </template>
  </div>
</template>

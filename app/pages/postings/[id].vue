<script setup lang="ts">
import { computed, ref } from 'vue'
import { normalizeUrl } from '#shared/postings'
import type { NotionWriteResult, PostingApplyResult, PostingDetail } from '../../../shared/types'

const route = useRoute()
const id = computed(() => String(route.params.id))

const { data, pending, error, refresh } = await useFetch<PostingDetail>(() => `/api/postings/${id.value}`, {
  key: () => `posting:${id.value}`,
})
const { refresh: refreshIndex } = usePostings()

const meta = computed(() => data.value?.meta)
const jd = computed(() => data.value?.jd ?? '')
const analysis = computed(() => data.value?.analysis ?? null)
useHead({ title: () => (meta.value ? `${meta.value.company} — posting` : 'Posting') })

// Already-in-the-tracker check, free: /api/stats is edge-cached and the
// tracker already carries every application's posting URL.
const { data: stats } = useStats()
const alreadyApplied = computed(() => {
  const url = meta.value?.url ? normalizeUrl(meta.value.url) : ''
  if (!url) return null
  return stats.value?.jobs.find((j) => j.url && normalizeUrl(j.url) === url) ?? null
})

const notice = ref<{ text: string; severity: 'success' | 'warn' | 'error' | 'info' } | null>(null)
function fail(err: any, what: string) {
  notice.value = { text: `${what}: ${err?.data?.statusMessage || err?.message || 'failed'}`, severity: 'error' }
}

// ---- actions ----
const busy = ref('')
const note = ref('')

async function act(key: string, run: () => Promise<unknown>, after?: () => void) {
  busy.value = key
  try {
    await run()
    await Promise.all([refresh(), refreshIndex()])
    after?.()
  } catch (err) {
    fail(err, "Couldn't save")
  } finally {
    busy.value = ''
  }
}

const buildPack = () =>
  act(
    'pack',
    () => $fetch(`/api/postings/${id.value}/pack`, { method: 'POST', body: { note: note.value } }),
    () => {
      notice.value = {
        text: 'Queued. The Mac tailors the CV and cover letter and uploads them here.',
        severity: 'success',
      }
    },
  )

async function markApplied() {
  busy.value = 'applied'
  try {
    const res = await $fetch<PostingApplyResult>(`/api/postings/${id.value}/applied`, { method: 'POST' })
    notice.value = res.notion.ok
      ? { text: 'Added to Notion. It joins the funnel within 5 minutes (the stats are cached).', severity: 'success' }
      : { text: `Marked applied here, but Notion refused: ${(res.notion as Extract<NotionWriteResult, { ok: false }>).error}`, severity: 'warn' }
    await Promise.all([refresh(), refreshIndex()])
  } catch (err) {
    fail(err, "Couldn't mark applied")
  } finally {
    busy.value = ''
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

function dismiss() {
  if (armed.value !== 'dismiss') return arm('dismiss')
  const next = meta.value?.state === 'dismissed' ? 'new' : 'dismissed'
  return act('dismiss', () => $fetch(`/api/postings/${id.value}/state`, { method: 'POST', body: { state: next } }))
}

async function remove() {
  if (armed.value !== 'delete') return arm('delete')
  try {
    await $fetch(`/api/postings/${id.value}`, { method: 'DELETE' })
    await refreshIndex()
    await navigateTo('/postings')
  } catch (err) {
    fail(err, "Couldn't delete the posting")
  }
}

async function deleteFile(name: string) {
  if (armed.value !== `file:${name}`) return arm(`file:${name}`)
  try {
    await $fetch(`/api/postings/${id.value}/artifacts/${encodeURIComponent(name)}`, { method: 'DELETE' })
    await refresh()
  } catch (err) {
    fail(err, "Couldn't delete the file")
  }
}

// ---- formatting ----
function when(iso: string | null): string {
  if (!iso) return '—'
  // A date-only value parses as UTC midnight and would render as the evening
  // before in local time — show it as the date it says it is.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return new Date(`${iso}T12:00:00`).toLocaleDateString('en-CA', { dateStyle: 'medium' })
  }
  return new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })
}
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`
const jdSize = computed(() =>
  jd.value.length >= 1000 ? `${Math.round(jd.value.length / 1000)}k characters` : `${jd.value.length} characters`,
)
const ICON: Record<string, string> = {
  cv: 'pi pi-file-pdf',
  'cover-letter': 'pi pi-envelope',
  notes: 'pi pi-file-edit',
  other: 'pi pi-file',
}

/** The decision strip: only the facts this posting actually carries. */
const facts = computed(() => {
  const m = meta.value
  const a = analysis.value
  if (!m) return []
  return [
    { k: 'Comp', v: m.comp || a?.advertisedComp || '' },
    { k: 'Where', v: m.geo || m.location },
    { k: 'Stack', v: m.stack },
    { k: 'Legitimacy', v: a?.legitimacy ?? '' },
    { k: 'Risk', v: a?.riskLevel ?? '' },
    { k: 'Work auth', v: a?.workAuth ?? '' },
    { k: 'Via', v: a?.via ?? '' },
    { k: 'Reports to', v: a?.reportsTo ?? '' },
  ].filter((f) => f.v)
})

/** Everything the report said that has no dedicated slot above. */
const extras = computed(() => {
  const e = analysis.value?.extra ?? {}
  return Object.entries(e).map(([k, v]) => ({ k: k.replace(/_/g, ' '), v }))
})

const lists = computed(() => {
  const a = analysis.value
  if (!a) return []
  return [
    { title: 'Hard stops', items: a.hardStops, tone: 'stop' },
    { title: 'Soft gaps', items: a.softGaps, tone: 'gap' },
    { title: 'Strengths', items: a.topStrengths, tone: 'good' },
  ].filter((l) => l.items.length)
})
</script>

<template>
  <div class="postings-page">
    <header>
      <div>
        <NuxtLink to="/postings" class="crumb"><i class="pi pi-arrow-left" /> Postings</NuxtLink>
        <h1 v-if="meta">{{ meta.company }}<span v-if="meta.role" class="pos"> · {{ meta.role }}</span></h1>
      </div>
    </header>

    <div v-if="pending" class="state"><PrimeProgressSpinner style="width: 44px; height: 44px" stroke-width="4" /></div>
    <PrimeMessage v-else-if="error" severity="error" :closable="false">
      {{ error.statusCode === 404 ? 'No such posting — it may have been deleted.' : error.message }}
    </PrimeMessage>

    <template v-else-if="meta">
      <PrimeMessage v-if="notice" :severity="notice.severity" @close="notice = null">{{ notice.text }}</PrimeMessage>
      <PrimeMessage v-if="alreadyApplied && !meta.notionPageId" severity="warn" :closable="false">
        Already in your tracker — you applied to this one on
        {{ alreadyApplied.date || 'an unknown date' }}.
      </PrimeMessage>

      <!-- The decision -->
      <PrimeCard class="sec" aria-label="The call">
        <template #content>
          <div class="verdict">
            <div class="score-block">
              <span class="big mono" :style="{ color: scoreColor(meta.score) }">
                {{ meta.score === null ? '—' : meta.score.toFixed(1) }}
              </span>
              <span class="of mono">/5</span>
            </div>
            <div class="verdict-text">
              <p v-if="analysis?.finalDecision" class="call">{{ analysis.finalDecision }}</p>
              <p v-if="meta.why" class="why">{{ meta.why }}</p>
              <p v-if="analysis?.archetype" class="arch">{{ analysis.archetype }}</p>
            </div>
            <div class="verdict-tags">
              <PrimeTag
                v-if="meta.state !== 'new'"
                :value="POSTING_STATE_LABEL[meta.state]"
                :severity="postingStateSeverity(meta.state)"
              />
            </div>
          </div>

          <dl v-if="facts.length" class="facts-grid">
            <template v-for="f in facts" :key="f.k">
              <dt>{{ f.k }}</dt>
              <dd>{{ f.v }}</dd>
            </template>
          </dl>

          <div class="posting-links">
            <a v-if="meta.url" :href="meta.url" target="_blank" rel="noopener">
              <i class="pi pi-external-link" /> The posting<span v-if="meta.source" class="mono muted"> · {{ meta.source }}</span>
            </a>
            <a v-if="meta.notionPageId" :href="`https://notion.so/${meta.notionPageId.replace(/-/g, '')}`" target="_blank" rel="noopener">
              <i class="pi pi-check-circle" /> In Notion
            </a>
            <ClientOnly>
              <span class="mono muted small">seen {{ when(meta.firstSeen || meta.createdAt) }}</span>
            </ClientOnly>
          </div>
        </template>
      </PrimeCard>

      <!-- What the evaluation found -->
      <PrimeCard v-if="lists.length || analysis?.nextAction || extras.length" class="sec" aria-label="The evaluation">
        <template #content>
          <h2>Evaluation<span v-if="meta.reportNum" class="mono muted"> · report {{ meta.reportNum }}</span></h2>
          <p v-if="analysis?.nextAction" class="next-action">{{ analysis.nextAction }}</p>
          <div v-for="l in lists" :key="l.title" class="finding">
            <h3 :class="l.tone">{{ l.title }}</h3>
            <ul class="finding-list">
              <li v-for="(item, i) in l.items" :key="i">{{ item }}</li>
            </ul>
          </div>
          <dl v-if="extras.length" class="facts-grid extras">
            <template v-for="e in extras" :key="e.k">
              <dt>{{ e.k }}</dt>
              <dd>{{ e.v }}</dd>
            </template>
          </dl>
        </template>
      </PrimeCard>

      <!-- The files -->
      <PrimeCard class="sec" aria-label="Application files">
        <template #content>
          <h2>Apply pack</h2>
          <div v-if="meta.artifacts.length" class="exports">
            <div v-for="f in meta.artifacts" :key="f.name" class="export">
              <a :href="`/api/postings/${id}/artifacts/${encodeURIComponent(f.name)}`">
                <i :class="ICON[f.kind]" /> <span class="name mono">{{ f.name }}</span>
              </a>
              <span class="mono muted">{{ kb(f.bytes) }}</span>
              <button
                type="button"
                class="linkish"
                :class="{ danger: armed === `file:${f.name}` }"
                @click="deleteFile(f.name)"
              >
                {{ armed === `file:${f.name}` ? 'really?' : 'delete' }}
              </button>
            </div>
          </div>
          <p v-else class="muted small">
            {{ meta.pack === 'requested' || meta.pack === 'building'
              ? 'The Mac is building it — it lands here when it is done.'
              : 'Nothing built yet.' }}
          </p>
          <p v-if="meta.pack === 'failed' && meta.packError" class="pack-error mono">{{ meta.packError }}</p>
          <ClientOnly>
            <p v-if="meta.packBuiltAt" class="muted small stamp">built {{ when(meta.packBuiltAt) }}</p>
          </ClientOnly>

          <div class="pack-actions">
            <PrimeInputText
              v-model="note"
              :placeholder="meta.packNote || 'Note for the build (emphasis, tone)…'"
              size="small"
              class="note"
            />
            <!-- The primary action moves with the state: build it, then send it. -->
            <PrimeButton
              :label="meta.pack === 'none' ? 'Build pack' : meta.pack === 'done' ? 'Rebuild' : 'Re-queue'"
              icon="pi pi-file-pdf"
              size="small"
              :severity="meta.pack === 'done' ? 'secondary' : 'primary'"
              :outlined="meta.pack === 'done'"
              :loading="busy === 'pack'"
              @click="buildPack"
            />
            <PrimeButton
              v-if="!meta.notionPageId"
              label="Mark applied"
              icon="pi pi-send"
              size="small"
              :severity="meta.pack === 'done' ? 'primary' : 'secondary'"
              :outlined="meta.pack !== 'done'"
              :loading="busy === 'applied'"
              @click="markApplied"
            />
            <PrimeButton
              :label="armed === 'dismiss' ? 'Really?' : meta.state === 'dismissed' ? 'Un-dismiss' : 'Dismiss'"
              icon="pi pi-times"
              size="small"
              :severity="armed === 'dismiss' ? 'danger' : 'secondary'"
              text
              :loading="busy === 'dismiss'"
              @click="dismiss"
            />
            <PrimeButton
              :label="armed === 'delete' ? 'Really delete?' : 'Delete'"
              icon="pi pi-trash"
              size="small"
              :severity="armed === 'delete' ? 'danger' : 'secondary'"
              text
              @click="remove"
            />
          </div>
        </template>
      </PrimeCard>

      <!-- The posting itself -->
      <PrimeCard v-if="jd" class="sec" aria-label="Job description">
        <template #content>
          <details class="jd">
            <summary>Job description<span class="mono muted"> · {{ jdSize }}</span></summary>
            <pre class="jd-body">{{ jd }}</pre>
          </details>
        </template>
      </PrimeCard>
    </template>
  </div>
</template>

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
function when(iso: string | null | undefined): string {
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
const KIND: Record<string, string> = {
  cv: 'CV',
  'cover-letter': 'Cover letter',
  notes: 'Tailoring notes',
  other: '',
}
const PACK_LABEL: Record<string, string> = {
  none: 'Not built',
  requested: 'Requested',
  building: 'Building…',
  done: 'Ready',
  failed: 'Failed',
}

/**
 * career-ops writes these as free text and spells them many ways, so the
 * colour is read off the words rather than matched against an enum — the
 * same reason cleanAnalysis keeps them as strings.
 */
function tone(v: unknown): string {
  const s = String(v ?? '').toLowerCase()
  if (!s) return 'var(--stone)'
  if (/high confidence|legit|verified|\blow\b|strong|citizen|not[_ ]needed|no sponsorship|authorized|permanent resident|\bpass\b|\byes\b/.test(s))
    return 'var(--green)'
  if (/medium|partial|moderate|likely|caution/.test(s)) return 'var(--amber)'
  if (/high risk|scam|weak|\bnone\b|no match|sponsorship required|suspicious|fail/.test(s)) return 'var(--danger)'
  return 'var(--stone)'
}

const scoreColor = computed(() => {
  const n = meta.value?.score
  if (n == null) return 'var(--faint)'
  if (n >= 4.5) return 'var(--green)'
  if (n >= 4.0) return 'var(--amber)'
  if (n >= 3.5) return 'var(--muted)'
  return 'var(--faint)'
})

/** The judgements a decision actually hinges on. */
const signals = computed(() => {
  const a = analysis.value
  if (!a) return []
  return [
    { k: 'Legitimacy', v: a.legitimacy },
    { k: 'Risk', v: a.riskLevel },
    { k: 'Work auth', v: a.workAuth },
    { k: 'Confidence', v: a.confidence },
  ]
    .filter((s) => s.v)
    .map((s) => ({ ...s, color: tone(s.v) }))
})

const facts = computed(() => {
  const m = meta.value
  const a = analysis.value
  if (!m) return []
  return [
    { k: 'Comp', v: m.comp || a?.advertisedComp || '', mono: true },
    { k: 'Where', v: m.geo || m.location, mono: false },
    { k: 'Via', v: a?.via ?? '', mono: false },
    { k: 'Reports to', v: a?.reportsTo ?? '', mono: false },
  ].filter((f) => f.v)
})

const requirements = computed(() =>
  (analysis.value?.requirements ?? []).map((r) => ({
    ...r,
    color: tone(r.match),
    match: r.match || '—',
    importance: r.importance || '',
    evidence: r.evidence || '',
  })),
)

/**
 * "must" is career-ops's older word; current reports say `critical`. Both
 * mean the requirement you cannot talk your way past.
 */
const reqSummary = computed(() => {
  const rs = requirements.value
  if (!rs.length) return ''
  const strong = rs.filter((r) => /strong/i.test(r.match)).length
  const musts = rs.filter((r) => /critical|must|required/i.test(r.importance))
  const met = musts.filter((r) => /strong/i.test(r.match)).length
  return `${strong}/${rs.length} strong` + (musts.length ? ` · ${met}/${musts.length} critical` : '')
})

/**
 * Stack chips tinted by what the requirements matrix says about each, so
 * "Postgres" reads differently when the JD called it critical and he only
 * partially matches. A plain chip when there is no matrix to check against.
 */
const stack = computed(() => {
  const m = meta.value
  if (!m?.stack) return []
  const reqText = requirements.value.map((r) => ({
    text: `${r.requirement} ${r.evidence}`.toLowerCase(),
    match: r.match.toLowerCase(),
  }))
  return m.stack
    .split(/,\s*|\s+on\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 14)
    .map((name) => {
      const first = name.toLowerCase().split(' ')[0]!
      const hit = reqText.find((t) => t.text.includes(first))
      const match = hit?.match ?? ''
      const level = /strong/.test(match) ? 3 : /partial|moderate/.test(match) ? 2 : /weak|none|no match/.test(match) ? 1 : 0
      return {
        name,
        color: ['var(--stone)', 'var(--rust)', 'var(--amber)', 'var(--green)'][level]!,
        title: ['not assessed', 'weak match', 'partial match', 'strong match'][level]!,
        assessed: level > 0,
      }
    })
})

const lists = computed(() => {
  const a = analysis.value
  if (!a) return []
  return [
    { title: 'Hard stops', items: a.hardStops, tone: 'stop' },
    { title: 'Soft gaps', items: a.softGaps, tone: 'gap' },
    { title: 'Strengths', items: a.topStrengths, tone: 'good' },
  ]
})

const risks = computed(() => Object.entries(analysis.value?.risk ?? {}).map(([k, v]) => ({ k, v })))
const extras = computed(() =>
  Object.entries(analysis.value?.extra ?? {}).map(([k, v]) => ({ k: k.replace(/_/g, ' '), v })),
)

const files = computed(() =>
  (meta.value?.artifacts ?? []).map((f) => ({
    ...f,
    label: KIND[f.kind] || f.name,
    icon: ICON[f.kind] ?? 'pi pi-file',
  })),
)

// ---- the rail's primary action, which moves with the state ----
const applied = computed(() => meta.value?.state === 'applied')
const packDone = computed(() => meta.value?.pack === 'done')
const inFlight = computed(() => meta.value?.pack === 'requested' || meta.value?.pack === 'building')

const primary = computed(() => {
  if (applied.value)
    return {
      label: 'Open in Notion',
      icon: 'pi pi-external-link',
      hint: `Applied ${when(meta.value?.appliedAt)}. It sits in the funnel as Awaiting reply.`,
    }
  if (packDone.value)
    return {
      label: 'Mark applied',
      icon: 'pi pi-send',
      hint: 'Send it through their site, then mark it here: a row goes into Notion and the funnel picks it up within 5 minutes.',
    }
  if (inFlight.value)
    return {
      label: 'Building the pack…',
      icon: 'pi pi-spin pi-spinner',
      hint: 'The Mac tailors the CV and cover letter and uploads them here. Usually 15–20 minutes.',
    }
  return {
    label: 'Build pack',
    icon: 'pi pi-file-pdf',
    hint: 'Queues the Mac to tailor a CV and cover letter to this JD.',
  }
})

const notionHref = computed(() =>
  meta.value?.notionPageId ? `https://notion.so/${meta.value.notionPageId.replace(/-/g, '')}` : '',
)

function onPrimary() {
  if (applied.value || inFlight.value) return
  if (packDone.value) return markApplied()
  return buildPack()
}
</script>

<template>
  <div class="postings-page brief">
    <header>
      <div class="brief-head">
        <NuxtLink to="/postings" class="crumb"><i class="pi pi-arrow-left" /> Postings</NuxtLink>
        <h1 v-if="meta">{{ meta.company }}<span v-if="meta.role" class="pos"> · {{ meta.role }}</span></h1>
      </div>
      <div v-if="meta" class="brief-meta mono">
        <span v-if="meta.state !== 'new'" class="state-pill" :class="meta.state">
          {{ meta.state === 'applied' ? 'Applied' : 'Dismissed' }}
        </span>
        <span v-if="meta.reportNum">report {{ meta.reportNum }} ·</span>
        <ClientOnly><span>seen {{ when(meta.firstSeen || meta.createdAt) }}</span></ClientOnly>
      </div>
    </header>

    <!-- Skeleton at the real dimensions, so nothing jumps (DESIGN.md §7.8) -->
    <div v-if="pending" class="brief-grid" aria-busy="true" aria-label="Loading posting">
      <div class="brief-main">
        <div class="skel-panel sk" style="height: 236px" />
        <div class="skel-panel sk" style="height: 420px; animation-delay: 120ms" />
      </div>
      <div class="brief-rail">
        <div class="skel-panel sk" style="height: 236px; animation-delay: 60ms" />
        <div class="skel-panel sk" style="height: 120px; animation-delay: 180ms" />
      </div>
    </div>

    <PrimeMessage v-else-if="error" severity="error" :closable="false">
      {{ error.statusCode === 404 ? 'No such posting — it may have been deleted.' : error.message }}
    </PrimeMessage>

    <template v-else-if="meta">
      <PrimeMessage v-if="notice" :severity="notice.severity" @close="notice = null">{{ notice.text }}</PrimeMessage>
      <PrimeMessage v-if="alreadyApplied && !meta.notionPageId" severity="warn" :closable="false">
        Already in your tracker — you applied to this one on {{ alreadyApplied.date || 'an unknown date' }}.
      </PrimeMessage>

      <div class="brief-grid">
        <div class="brief-main">
          <!-- The call -->
          <PrimeCard class="sec" aria-label="The call">
            <template #content>
              <div class="verdict">
                <div class="score-block">
                  <div class="score-n">
                    <span class="big mono" :style="{ color: scoreColor }">
                      {{ meta.score === null ? '—' : meta.score.toFixed(1) }}
                    </span>
                    <span class="of mono">/5</span>
                  </div>
                  <div class="score-track">
                    <span class="score-fill" :style="{ background: scoreColor, width: ((meta.score ?? 0) / 5) * 100 + '%' }" />
                  </div>
                </div>
                <div class="verdict-text">
                  <p v-if="analysis?.finalDecision" class="call">{{ analysis.finalDecision }}</p>
                  <p v-if="meta.why" class="why">{{ meta.why }}</p>
                  <p v-if="analysis?.archetype" class="arch">{{ analysis.archetype }}</p>
                </div>
              </div>

              <div v-if="signals.length" class="signals">
                <span v-for="s in signals" :key="s.k" class="signal">
                  <span class="dot" :style="{ background: s.color }" />
                  <span class="sig-k">{{ s.k }}</span> {{ s.v }}
                </span>
              </div>

              <dl v-if="facts.length || stack.length" class="facts-grid">
                <template v-for="f in facts" :key="f.k">
                  <dt>{{ f.k }}</dt>
                  <dd :class="{ mono: f.mono }">{{ f.v }}</dd>
                </template>
                <template v-if="stack.length">
                  <dt class="mid">Stack</dt>
                  <dd class="chips">
                    <span
                      v-for="t in stack"
                      :key="t.name"
                      class="chip mono"
                      :class="{ assessed: t.assessed }"
                      :title="t.title"
                      :style="t.assessed ? { borderColor: t.color, color: 'var(--text)' } : undefined"
                    >
                      <span class="dot" :style="{ background: t.color }" />{{ t.name }}
                    </span>
                  </dd>
                </template>
              </dl>
            </template>
          </PrimeCard>

          <!-- The evaluation -->
          <PrimeCard v-if="analysis" class="sec" aria-label="The evaluation">
            <template #content>
              <h2>Evaluation</h2>
              <p v-if="analysis.nextAction" class="next-action">
                <i class="pi pi-flag" /><span>{{ analysis.nextAction }}</span>
              </p>

              <div class="findings">
                <div v-for="l in lists" :key="l.title" class="finding">
                  <h3 :class="l.tone">{{ l.title }}<span class="n mono">{{ l.items.length }}</span></h3>
                  <p v-if="!l.items.length" class="muted small none">None found.</p>
                  <ul v-else class="finding-list">
                    <li v-for="(item, i) in l.items" :key="i">{{ item }}</li>
                  </ul>
                </div>
              </div>

              <!-- What the JD asked for against what he has. The payload has
                   carried this since the first push; nothing rendered it. -->
              <div v-if="requirements.length" class="reqs">
                <div class="reqs-head">
                  <h3>Requirements <span class="mono">· {{ reqSummary }}</span></h3>
                  <span class="sec-note">what the JD asked for, and what you have</span>
                </div>
                <div v-for="(r, i) in requirements" :key="i" class="req">
                  <span class="req-text">
                    <span class="dot" :style="{ background: r.color }" />
                    <span>{{ r.requirement }}</span>
                  </span>
                  <span class="req-imp mono">{{ r.importance }}</span>
                  <span class="req-match" :style="{ color: r.color }">
                    {{ r.match }}<span v-if="r.evidence" class="faint"> · {{ r.evidence }}</span>
                  </span>
                </div>
              </div>

              <dl v-if="risks.length" class="facts-grid lower">
                <template v-for="r in risks" :key="r.k">
                  <dt class="low">{{ r.k }}</dt>
                  <dd>{{ r.v }}</dd>
                </template>
              </dl>

              <details v-if="extras.length" class="extras-toggle">
                <summary class="mono">everything else the report said · {{ extras.length }}</summary>
                <dl class="facts-grid lower">
                  <template v-for="e in extras" :key="e.k">
                    <dt class="low">{{ e.k }}</dt>
                    <dd>{{ e.v }}</dd>
                  </template>
                </dl>
              </details>
            </template>
          </PrimeCard>

        </div>

        <!-- The rail: what to do next, and what has been built -->
        <aside class="brief-rail">
          <PrimeCard class="sec rail-next" aria-label="Next">
            <template #content>
              <h2 class="rail-title">Next</h2>
              <a
                v-if="applied"
                class="rail-primary as-link"
                :href="notionHref"
                target="_blank"
                rel="noopener"
              >
                <i :class="primary.icon" />{{ primary.label }}
              </a>
              <PrimeButton
                v-else
                class="rail-primary"
                :label="primary.label"
                :icon="primary.icon"
                :loading="busy === 'applied' || busy === 'pack'"
                :disabled="inFlight"
                @click="onPrimary"
              />
              <p class="rail-hint">{{ primary.hint }}</p>

              <div class="rail-pack">
                <div class="rail-pack-head">
                  <span class="rail-label">Apply pack</span>
                  <span class="pack-chip" :class="'is-' + meta.pack">
                    <i class="pi pi-file-pdf" />{{ PACK_LABEL[meta.pack] }}
                  </span>
                </div>

                <div v-if="files.length" class="rail-files">
                  <div v-for="f in files" :key="f.name" class="rail-file">
                    <a :href="`/api/postings/${id}/artifacts/${encodeURIComponent(f.name)}`">
                      <i :class="f.icon" /><span class="name">{{ f.label }}</span>
                    </a>
                    <span class="mono faint">{{ kb(f.bytes) }}</span>
                    <button
                      type="button"
                      class="linkish"
                      :class="{ danger: armed === `file:${f.name}` }"
                      :aria-label="`Delete ${f.name}`"
                      @click="deleteFile(f.name)"
                    >
                      {{ armed === `file:${f.name}` ? 'really?' : 'delete' }}
                    </button>
                  </div>
                </div>
                <p v-else class="muted small">
                  {{ inFlight ? 'The Mac is building it — it lands here when it is done.' : 'Nothing built yet.' }}
                </p>

                <p v-if="meta.pack === 'failed' && meta.packError" class="pack-error mono">{{ meta.packError }}</p>
                <ClientOnly>
                  <p v-if="meta.packBuiltAt" class="faint small mono built">
                    built {{ when(meta.packBuiltAt) }}<template v-if="meta.packNote"> · “{{ meta.packNote }}”</template>
                  </p>
                </ClientOnly>

                <div class="rail-build">
                  <PrimeInputText
                    v-model="note"
                    :placeholder="meta.packNote || 'Note for the build (emphasis, tone)…'"
                    size="small"
                    aria-label="Note for the build"
                  />
                  <PrimeButton
                    :label="meta.pack === 'none' ? 'Build' : packDone ? 'Rebuild' : 'Re-queue'"
                    icon="pi pi-refresh"
                    size="small"
                    severity="secondary"
                    outlined
                    :loading="busy === 'pack'"
                    @click="buildPack"
                  />
                </div>
              </div>

              <div class="rail-danger">
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

          <PrimeCard class="sec rail-links" aria-label="Links">
            <template #content>
              <a v-if="meta.url" :href="meta.url" target="_blank" rel="noopener">
                <i class="pi pi-external-link" />The posting<span v-if="meta.source" class="mono muted"> · {{ meta.source }}</span>
              </a>
              <a v-if="notionHref" :href="notionHref" target="_blank" rel="noopener">
                <i class="pi pi-check-circle in-notion" />In Notion<ClientOnly><span class="mono muted"> · applied {{ when(meta.appliedAt) }}</span></ClientOnly>
              </a>
              <ClientOnly>
                <span v-if="meta.postedAt || meta.location" class="faint small mono">
                  <template v-if="meta.postedAt">posted {{ when(meta.postedAt) }}</template>
                  <template v-if="meta.postedAt && meta.location"> · </template>
                  <template v-if="meta.location">{{ meta.location }}</template>
                </span>
              </ClientOnly>
            </template>
          </PrimeCard>
        </aside>

        <!-- The posting itself. Its own grid child rather than part of the
             main column: stacked on a phone that keeps the JD — the longest
             block and the least often read — below the actions, instead of
             burying "Build pack" under two hundred lines of it. -->
        <PrimeCard v-if="jd" class="sec brief-jd" aria-label="Job description">
          <template #content>
            <details class="jd">
              <summary>Job description<span class="mono muted"> · {{ jdSize }}</span></summary>
              <pre class="jd-body">{{ jd }}</pre>
            </details>
          </template>
        </PrimeCard>
      </div>
    </template>
  </div>
</template>

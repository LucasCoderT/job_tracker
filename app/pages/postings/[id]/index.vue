<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { normalizeUrl } from '#shared/postings'
import type { NotionWriteResult, PostingApplyResult, PostingDetail } from '../../../../shared/types'

const route = useRoute()
const id = computed(() => String(route.params.id))

const { data, pending, error, refresh } = await useFetch<PostingDetail>(() => `/api/postings/${id.value}`, {
  key: () => `posting:${id.value}`,
})
const { refresh: refreshIndex } = usePostings()

const meta = computed(() => data.value?.meta)

/**
 * The brief waits on more than a pack: a new posting has no evaluation yet, and
 * that arrives from the eval worker rather than from anything he pressed. Both
 * count as waiting, so the page fills itself in as each piece lands.
 */
const waitingHere = computed(() => {
  const m = meta.value
  if (!m) return 0
  let n = 0
  if (isWaitingStatus(m.pack)) n++
  if (isWaitingStatus(m.answerStatus)) n++
  if (isWaitingStatus(m.parseStatus)) n++
  // An evaluation is only *pending* for a posting young enough to still be in
  // the worker's sights. It runs hourly and skips anything under its score
  // gate, so on an older posting "waiting to be evaluated" would be a badge
  // that never clears — the Northbeam posting needed --id by hand today for
  // exactly that reason.
  if (!m.hasAnalysis && m.state === 'new' && Date.now() - Date.parse(m.createdAt) < 2 * 3600_000) n++
  return n
})
const waitingLabel = computed(() => {
  const m = meta.value
  if (!m) return ''
  if (isWaitingStatus(m.pack)) return m.pack === 'building' ? 'building your pack' : 'pack queued'
  if (isWaitingStatus(m.answerStatus)) return 'drafting answers'
  if (isWaitingStatus(m.parseStatus)) return 'Claude is re-reading the form'
  return 'waiting to be evaluated'
})
const { refreshing: liveRefreshing, status: liveStatus } = useLiveRefresh({
  refresh: () => Promise.all([refresh(), refreshIndex()]),
  waiting: () => waitingHere.value > 0,
  id: () => id.value,
})

// Back goes where he came from — the dashboard's "Worth a look", the postings
// list, or a pack — rather than always to /postings. See useTrail.
const { crumbs, parent } = useTrail(() => [{ label: meta.value?.company || 'Posting' }], '/postings')

// Opening the brief is what marks a posting read on the dashboard. Client-side
// only and fire-and-forget: it must not delay the page or fail it.
onMounted(() => {
  if (meta.value && !meta.value.openedAt) {
    $fetch(`/api/postings/${id.value}/opened`, { method: 'POST' }).catch(() => {})
  }
})
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

const buildPack = () => {
  buildOpen.value = false
  return act(
    'pack',
    () => $fetch(`/api/postings/${id.value}/pack`, { method: 'POST', body: { note: note.value } }),
    () => {
      notice.value = {
        text: 'Queued. The Mac tailors the CV and cover letter and uploads them here.',
        severity: 'success',
      }
    },
  )
}

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
  deleteOpen.value = false
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

// ---- the job description ----
//
// Captured straight from the posting when it arrives (server/utils/jd-capture.ts),
// fetched on the Mac for LinkedIn, or pasted here. It is third-party text, so
// it is escaped first and only the light Markdown the capture writes — ##
// headings, - bullets, **bold**, https links — is turned back into markup.

const JD_SOURCE: Record<string, string> = {
  greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', linkedin: 'LinkedIn',
  page: 'the posting page', pasted: 'pasted by you', 'career-ops': 'the career-ops evaluation',
}
const jdFrom = computed(() => (meta.value?.jdSource ? JD_SOURCE[meta.value.jdSource] ?? meta.value.jdSource : ''))

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
function inlineMd(s: string) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener nofollow">$1</a>')
}
const jdHtml = computed(() => {
  const out: string[] = []
  let list: string[] = []
  const endList = () => {
    if (list.length) out.push(`<ul>${list.map((i) => `<li>${i}</li>`).join('')}</ul>`)
    list = []
  }
  for (const block of escapeHtml(jd.value).split(/\n{2,}/)) {
    for (const line of block.split('\n')) {
      const t = line.trim()
      if (!t) continue
      const h = t.match(/^#{1,6}\s+(.*)$/)
      const b = t.match(/^[-*•]\s+(.*)$/)
      if (h) { endList(); out.push(`<h4>${inlineMd(h[1]!)}</h4>`) }
      else if (b) list.push(inlineMd(b[1]!))
      else { endList(); out.push(`<p>${inlineMd(t)}</p>`) }
    }
    endList()
  }
  return out.join('')
})

const pasting = ref(false)
const pasteText = ref('')

function fetchJD() {
  return act('jd', async () => {
    const res = await $fetch<{ jd: string | null; error: string | null }>(`/api/postings/${id.value}/jd/capture`, { method: 'POST' })
    notice.value = res.jd
      ? { text: 'Job description fetched from the posting.', severity: 'success' }
      : { text: `Couldn't fetch it: ${res.error}. You can paste it instead.`, severity: 'warn' }
  })
}

function saveJD() {
  return act(
    'jd',
    () => $fetch(`/api/postings/${id.value}/jd`, { method: 'PUT', body: { text: pasteText.value } }),
    () => {
      pasting.value = false
      pasteText.value = ''
      notice.value = { text: 'Job description saved.', severity: 'success' }
    },
  )
}

function syncNotion() {
  return act('notion', async () => {
    const res = await $fetch<{ ok: boolean; created: string[]; wroteSummary: boolean; error?: string }>(
      `/api/postings/${id.value}/notion-sync`,
      { method: 'POST' },
    )
    if (!res.ok) notice.value = { text: `Notion page not updated: ${res.error}`, severity: 'warn' }
    else if (!res.created.length && !res.wroteSummary) notice.value = { text: 'The Notion page already has everything.', severity: 'info' }
    else {
      const added = [...(res.wroteSummary ? ['the summary and Timeline'] : []), ...res.created]
      notice.value = { text: `Added to the Notion page: ${added.join(', ')}.`, severity: 'success' }
    }
  })
}
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

/**
 * Findings as one table rather than three columns. Three columns forced every
 * finding into a third of the width, so a two-line gap wrapped to four; the
 * kind is a label on the first row of its group instead, and the text gets the
 * full measure.
 */
const findingRows = computed(() => {
  const rows: {
    first: boolean; last: boolean; kind: string; n: number; tone: string; text: string; muted: boolean
  }[] = []
  for (const l of lists.value) {
    if (!l.items.length) {
      rows.push({ first: true, last: true, kind: l.title, n: 0, tone: l.tone, text: 'None found.', muted: true })
      continue
    }
    l.items.forEach((text, i) =>
      rows.push({ first: i === 0, last: i === l.items.length - 1, kind: l.title, n: l.items.length, tone: l.tone, text, muted: false }),
    )
  }
  return rows
})

const findSummary = computed(() => {
  const a = analysis.value
  if (!a) return ''
  return `${a.hardStops.length} stops · ${a.softGaps.length} gaps · ${a.topStrengths.length} strengths`
})

// Build and delete are dialogs now. Not browser dialogs — an in-page modal,
// which is what the no-`confirm()` rule was actually about: it says what will
// be removed instead of relying on him remembering what "Really delete?" meant.
/**
 * What the evaluation recorded as a hard stop: US-only work authorization, a
 * closed listing, a mandatory relocation. A pack costs a median of 41 minutes
 * of machine time and a slot in his attention, and these have been sitting in
 * the analysis unread while the build button behaved identically either way.
 * The build is not blocked — an evaluation can be wrong, and the call is his —
 * but it stops being the default.
 */
const hardStops = computed<string[]>(() => {
  const stops = [...(analysis.value?.hardStops ?? [])]
  // A dead listing is the most definitive hard stop there is, and unlike the
  // others it was verified rather than judged.
  if (meta.value?.closedAt) stops.unshift(meta.value.closedReason || 'The listing is no longer accepting applications.')
  return stops
})

const buildOpen = ref(false)
const deleteOpen = ref(false)

const fileCount = computed(() => {
  const n = meta.value?.artifacts.length ?? 0
  return n === 1 ? '1 built file' : `${n} built files`
})

const deleteNote = computed(() =>
  applied.value
    ? 'The Notion row and the funnel are untouched — this only removes the posting record here.'
    : 'The morning scan can push it back up if it scores again; Dismiss is the quieter option if you just want it out of the way.',
)

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

/** Just the host, so the link says where it goes without wrapping a long req URL. */
const employerHost = computed(() => {
  const raw = meta.value?.employerUrl
  if (!raw) return ''
  try {
    return new URL(raw).hostname.replace(/^www\./, '')
  } catch {
    return raw.slice(0, 40)
  }
})

function onPrimary() {
  if (applied.value || inFlight.value) return
  if (packDone.value) return markApplied()
  buildOpen.value = true
}
</script>

<template>
  <div class="postings-page brief">
    <header>
      <div class="brief-head">
        <AppCrumbs :crumbs="crumbs" />
        <h1 v-if="meta">{{ meta.company }}<span v-if="meta.role" class="pos"> · {{ meta.role }}</span></h1>
        <LiveWaiting :count="waitingHere" :refreshing="liveRefreshing" :status="liveStatus" :label="waitingLabel" />
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

              <div v-if="findingRows.length" class="eval-sec">
                <h3>Findings <span class="mono">· {{ findSummary }}</span></h3>
              </div>
              <div class="table-scroll">
                <table class="findings-table">
                  <tbody>
                    <tr v-for="(f, i) in findingRows" :key="i" :class="{ 'group-end': f.last && i < findingRows.length - 1 }">
                      <td class="kind" :class="{ pt: f.first, pb: f.last }">
                        <span v-if="f.first" class="kind-label" :class="f.tone">
                          <span class="dot" />{{ f.kind }}<span class="n mono">{{ f.n }}</span>
                        </span>
                      </td>
                      <td class="finding-text" :class="{ pt: f.first, pb: f.last, muted: f.muted }">{{ f.text }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- What the JD asked for against what he has. The payload has
                   carried this since the first push; nothing rendered it. -->
              <template v-if="requirements.length">
                <div class="eval-sec">
                  <h3>Requirements <span class="mono">· {{ reqSummary }}</span></h3>
                  <span class="sec-note">what the JD asked for, and what you have</span>
                </div>
                <div class="table-scroll">
                  <table class="reqs-table">
                    <thead>
                      <tr>
                        <th>Requirement</th>
                        <th class="tight">Importance</th>
                        <th class="tight">Match</th>
                        <th class="tight">Evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(r, i) in requirements" :key="i">
                        <td class="req-name">{{ r.requirement }}</td>
                        <td class="req-imp mono" :class="{ critical: /critical|must|required/i.test(r.importance) }">
                          {{ r.importance || '—' }}
                        </td>
                        <td class="req-match">
                          <span :style="{ color: r.color }"><span class="dot" :style="{ background: r.color }" />{{ r.match }}</span>
                        </td>
                        <td class="req-ev">{{ r.evidence || '—' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </template>

              <template v-if="risks.length">
                <div class="eval-sec"><h3>Risk</h3></div>
                <dl class="facts-grid lower risk-grid">
                  <template v-for="r in risks" :key="r.k">
                    <dt class="low">{{ r.k }}</dt>
                    <dd>{{ r.v }}</dd>
                  </template>
                </dl>
              </template>

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
                    <a class="file-card" :href="`/api/postings/${id}/artifacts/${encodeURIComponent(f.name)}`">
                      <i :class="f.icon" />
                      <span class="file-meta">
                        <span class="file-label">{{ f.label }}</span>
                        <span class="file-sub mono">{{ f.name }} · {{ kb(f.bytes) }}</span>
                      </span>
                      <i class="pi pi-download go" />
                    </a>
                    <button
                      type="button"
                      class="file-del"
                      :class="{ armed: armed === `file:${f.name}` }"
                      :aria-label="`Delete ${f.name}`"
                      :title="armed === `file:${f.name}` ? 'Really delete?' : 'Delete'"
                      @click="deleteFile(f.name)"
                    >
                      <i :class="armed === `file:${f.name}` ? 'pi pi-exclamation-triangle' : 'pi pi-trash'" />
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

                <PrimeButton
                  class="rail-build"
                  :label="meta.pack === 'none' ? 'Build' : packDone ? 'Rebuild' : 'Re-queue'"
                  icon="pi pi-refresh"
                  size="small"
                  severity="secondary"
                  outlined
                  :loading="busy === 'pack'"
                  @click="buildOpen = true"
                />
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

          <!--
            The employer's own req, when career-ops resolved one. It leads,
            because that is the link to apply through: applications sent on the
            employer's page reach a screen at 15.4% against 4.9% through the
            aggregators, and both processes that ever reached a third round came
            in that way. The aggregator link stays below it, labelled as where
            it was found rather than where to apply.
          -->
          <a
            v-if="meta.employerUrl"
            class="link-card link-card--primary"
            :href="meta.employerUrl"
            target="_blank"
            rel="noopener"
            aria-label="Apply on the employer's own posting"
          >
            <span class="link-meta">
              <span class="link-title">Apply on the employer's site</span>
              <span class="link-sub mono">{{ employerHost }} · far better odds than the board</span>
            </span>
            <i class="pi pi-external-link go" />
          </a>

          <a
            v-if="meta.url"
            class="link-card"
            :href="meta.url"
            target="_blank"
            rel="noopener"
            :aria-label="`Open the posting on ${meta.source || 'its site'}`"
          >
            <span class="link-meta">
              <span class="link-title">{{ meta.employerUrl ? 'Where it was found' : 'The posting' }}<span v-if="meta.source" class="mono muted"> · {{ meta.source }}</span></span>
              <ClientOnly>
                <span v-if="meta.postedAt || meta.location" class="link-sub mono">
                  <template v-if="meta.postedAt">posted {{ when(meta.postedAt) }}</template>
                  <template v-if="meta.postedAt && meta.location"> · </template>
                  <template v-if="meta.location">{{ meta.location }}</template>
                </span>
              </ClientOnly>
            </span>
            <i class="pi pi-external-link go" />
          </a>

          <!--
            First-call prep. Seven of the ten applications that reached an
            interview stopped at the first screen, so this is reachable from
            every posting, not only the ones with a booked call.
          -->
          <NuxtLink class="link-card" :to="`/postings/${id}/screen?from=${parent}`">
            <span class="link-meta">
              <span class="link-title">Screen prep</span>
              <span class="link-sub mono">the first call, in your words</span>
            </span>
            <i class="pi pi-angle-right go" />
          </NuxtLink>

          <!-- The supplemental questions a form asks, and their drafted answers. -->
          <NuxtLink class="link-card" :to="`/postings/${id}/questions?from=${parent}`">
            <span class="link-meta">
              <span class="link-title"><i class="pi pi-list-check" />Application questions</span>
              <span class="link-sub mono">
                <template v-if="meta.questions">{{ meta.answered }} of {{ meta.questions }} answered</template>
                <template v-else>none added yet</template>
              </span>
            </span>
            <i class="pi pi-angle-right go" />
          </NuxtLink>

          <a v-if="notionHref" class="link-card" :href="notionHref" target="_blank" rel="noopener">
            <span class="link-meta">
              <span class="link-title"><i class="pi pi-check-circle in-notion" />In Notion</span>
              <ClientOnly><span class="link-sub mono">applied {{ when(meta.appliedAt) }}</span></ClientOnly>
            </span>
            <i class="pi pi-external-link go" />
          </a>
          <!-- Fills in the page's summary and the Job Description / Apply Pack /
               Analytics sub-pages that are missing; never touches what is there. -->
          <button v-if="notionHref" type="button" class="linkish notion-sync" :disabled="busy === 'notion'" @click="syncNotion">
            <i :class="busy === 'notion' ? 'pi pi-spin pi-spinner' : 'pi pi-sync'" /> Update Notion page
          </button>
        </aside>

        <!-- The posting itself. Its own grid child rather than part of the
             main column: stacked on a phone that keeps the JD — the longest
             block and the least often read — below the actions, instead of
             burying "Build pack" under two hundred lines of it. -->
        <PrimeCard class="sec brief-jd" aria-label="Job description">
          <template #content>
            <!-- Open by default when there is no evaluation: then the JD is the
                 substance of the page, not the long tail beneath it. -->
            <details v-if="jd" class="jd" :open="!analysis">
              <summary>
                Job description<span class="mono muted"> · {{ jdSize }}<template v-if="jdFrom"> · from {{ jdFrom }}</template></span>
              </summary>
              <div class="jd-body" v-html="jdHtml" />
            </details>

            <div v-else class="jd-missing">
              <div class="eval-sec jd-missing-head">
                <h3>Job description</h3>
              </div>
              <p class="jd-missing-why">
                <template v-if="meta.jdError">Couldn't fetch it: {{ meta.jdError }}.</template>
                <template v-else>Not fetched yet.</template>
                <template v-if="meta.jdError && /LinkedIn/.test(meta.jdError)"> The Mac fetches LinkedIn descriptions every half hour, so this usually fills in on its own.</template>
              </p>
              <div v-if="!pasting" class="jd-missing-actions">
                <PrimeButton label="Fetch it" icon="pi pi-download" size="small" severity="secondary" outlined :loading="busy === 'jd'" @click="fetchJD" />
                <PrimeButton label="Paste it" icon="pi pi-clipboard" size="small" severity="secondary" text @click="pasting = true" />
              </div>
              <div v-else class="jd-paste">
                <PrimeTextarea v-model="pasteText" rows="10" placeholder="Paste the job description from the posting…" autocomplete="off" />
                <div class="jd-missing-actions">
                  <PrimeButton label="Cancel" size="small" severity="secondary" text @click="pasting = false" />
                  <PrimeButton label="Save" icon="pi pi-check" size="small" :disabled="pasteText.trim().length < 100" :loading="busy === 'jd'" @click="saveJD" />
                </div>
              </div>
            </div>
          </template>
        </PrimeCard>
      </div>

      <!-- Build: a note steers emphasis, so it gets room to be written rather
           than a one-line field wedged into a 300px rail. -->
      <PrimeDialog
        v-model:visible="buildOpen"
        modal
        :header="meta.pack === 'none' ? 'Build the apply pack' : 'Rebuild the apply pack'"
        :style="{ width: 'min(520px, calc(100vw - 32px))' }"
      >
        <div class="build-dialog">
          <div v-if="hardStops.length" class="build-stops">
            <p class="build-stops-head">
              <i class="pi pi-exclamation-triangle" />
              {{ hardStops.length === 1 ? 'The evaluation recorded a hard stop' : `The evaluation recorded ${hardStops.length} hard stops` }}
            </p>
            <ul>
              <li v-for="(stop, i) in hardStops" :key="i">{{ stop }}</li>
            </ul>
            <p class="build-stops-foot">Build it anyway if that is wrong or you want the pack regardless.</p>
          </div>
          <p class="muted small">
            The Mac tailors a CV and cover letter to this JD and uploads them here — usually 15–20 minutes.
            A note steers the emphasis and tone.
          </p>
          <label>
            <span>Note for the build <small>optional</small></span>
            <PrimeTextarea
              v-model="note"
              rows="5"
              :placeholder="meta.packNote || 'Note for the build (emphasis, tone)…'"
              autocomplete="off"
            />
          </label>
          <p v-if="meta.packNote" class="faint small mono">last build: “{{ meta.packNote }}”</p>
        </div>
        <template #footer>
          <PrimeButton label="Cancel" severity="secondary" text size="small" @click="buildOpen = false" />
          <PrimeButton
            :label="hardStops.length ? 'Build it anyway' : meta.pack === 'none' ? 'Build pack' : 'Rebuild'"
            icon="pi pi-refresh"
            size="small"
            :severity="hardStops.length ? 'warning' : undefined"
            :loading="busy === 'pack'"
            @click="buildPack"
          />
        </template>
      </PrimeDialog>

      <!-- Delete: a modal rather than the arm-then-confirm used elsewhere.
           Not a browser dialog, so it does not block automation or screen
           readers — and unlike "Really delete?" it says what goes with it. -->
      <PrimeDialog
        v-model:visible="deleteOpen"
        modal
        header="Delete this posting?"
        :style="{ width: 'min(440px, calc(100vw - 32px))' }"
      >
        <div class="delete-dialog">
          <p>
            Removes <b>{{ meta.company }}<template v-if="meta.role"> · {{ meta.role }}</template></b>
            from postings, along with its job description, the evaluation, and {{ fileCount }}.
          </p>
          <p class="muted">{{ deleteNote }}</p>
        </div>
        <template #footer>
          <PrimeButton label="Cancel" severity="secondary" text size="small" @click="deleteOpen = false" />
          <PrimeButton label="Delete posting" icon="pi pi-trash" severity="danger" size="small" @click="remove" />
        </template>
      </PrimeDialog>
    </template>
  </div>
</template>

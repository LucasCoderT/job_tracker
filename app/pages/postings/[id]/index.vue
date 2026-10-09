<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { letterText, normalizeUrl, evaluationExpected, postingChannel } from '#shared/postings'
import { inPackTest, packArm } from '#shared/pack-test'
import { jobStatusLabel, canChangeStatus } from '#shared/pipeline'
import type { NotionWriteResult, PostingApplyResult, PostingDetail } from '../../../../shared/types'

const route = useRoute()
const id = computed(() => String(route.params.id))

const { data, pending, error, refresh } = await useFetch<PostingDetail>(() => `/api/postings/${id.value}`, {
  key: () => `posting:${id.value}`,
})
const { refresh: refreshIndex, postings: allPostings } = usePostings()

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
  if (isWaitingStatus(m.evalStatus)) n++
  // An evaluation is only *pending* when one is actually coming: the worker
  // skips anything under its score gate (EVAL_MIN_SCORE), so for those the
  // badge promised something that never arrived. Still bounded by age, since a
  // worker that has not reached a posting in two hours is not about to.
  if (m.state === 'new' && !isWaitingStatus(m.evalStatus) && evaluationExpected(m) && Date.now() - Date.parse(m.createdAt) < 2 * 3600_000) n++
  return n
})
const waitingLabel = computed(() => {
  const m = meta.value
  if (!m) return ''
  if (isWaitingStatus(m.evalStatus)) return m.evalStatus === 'building' ? 're-evaluating' : 're-evaluation queued'
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
const reason = (err: any) => err?.data?.statusMessage || err?.message || 'no reason was given'
function fail(err: any, what: string) {
  notice.value = { text: `${what}: ${reason(err)}`, severity: 'error' }
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

/**
 * Ask for a fresh evaluation.
 *
 * Needed because the worker only drains postings *without a valid evaluation*,
 * so a posting that already has one can never be re-read on its own — which is
 * wrong whenever the inputs changed underneath it. Both cases happened this
 * week: an evaluation written from no JD at all, and one that scored a stub
 * before the company and role were known.
 */
const reEvalOpen = ref(false)
const reEvalNote = ref('')
/** Queued or running, so the button disables itself rather than double-queueing. */
const evalWaiting = computed(() => isWaitingStatus(meta.value?.evalStatus))
/** A re-evaluation with no JD stored is much weaker; the dialog says so. */
const hasJD = computed(() => Boolean(jd.value))
const reEvaluate = () => {
  reEvalOpen.value = false
  return act(
    'eval',
    () => $fetch(`/api/postings/${id.value}/evaluate`, { method: 'POST', body: { note: reEvalNote.value } }),
    () => {
      reEvalNote.value = ''
      notice.value = {
        text: 'Queued. The Mac re-reads the JD and replaces the evaluation here when it is done.',
        severity: 'success',
      }
    },
  )
}

const buildPack = () => {
  buildOpen.value = false
  return act(
    'pack',
    () => $fetch(`/api/postings/${id.value}/pack`, { method: 'POST', body: { note: note.value, leaveTest: testArm.value === 'base' } }),
    () => {
      notice.value = {
        text: 'Queued. The Mac tailors the CV and cover letter and uploads them here.',
        severity: 'success',
      }
    },
  )
}

/**
 * What happened to the last "Mark as applied", said beside the button.
 *
 * Every result used to go to the notice above the grid, which on a phone is
 * about 750px above the thumb that pressed it. For the one action that writes a
 * Notion row, a failure that looks like nothing happened is the worst outcome:
 * he either believes an application is recorded when it is not, or presses again.
 */
const applyNote = ref<{ text: string; tone: 'ok' | 'warn' | 'error' | 'quiet' } | null>(null)

async function markApplied() {
  busy.value = 'applied'
  applyNote.value = null
  try {
    const res = await $fetch<PostingApplyResult>(`/api/postings/${id.value}/applied`, { method: 'POST' })
    applyNote.value = res.notion.ok
      ? { text: 'Recorded in Notion. It joins the funnel within 5 minutes.', tone: 'ok' }
      : { text: `Marked applied here, but Notion refused: ${(res.notion as Extract<NotionWriteResult, { ok: false }>).error}`, tone: 'warn' }
    await Promise.all([refresh(), refreshIndex()])
  } catch (err) {
    applyNote.value = { text: `Not recorded: ${reason(err)}. Nothing was written, so it is safe to try again.`, tone: 'error' }
  } finally {
    busy.value = ''
  }
}

// ---- two-step deletes (the app's own convention: arm, then confirm) ----
const armed = ref<string | null>(null)
/** Seconds left to confirm, counted down on the armed control so the window is not a guess. */
const armedLeft = ref(0)
let disarm: ReturnType<typeof setInterval> | undefined
function arm(key: string) {
  armed.value = key
  armedLeft.value = 4
  if (key === 'applied') applyNote.value = null
  clearInterval(disarm)
  disarm = setInterval(() => {
    armedLeft.value--
    if (armedLeft.value > 0) return
    clearInterval(disarm)
    // A lapsed confirm on the Notion write says so; it used to just go back.
    if (armed.value === 'applied') applyNote.value = { text: 'Not recorded. The confirm timed out.', tone: 'quiet' }
    armed.value = null
  }, 1000)
}
function disarmNow() {
  clearInterval(disarm)
  armed.value = null
}
onBeforeUnmount(() => clearInterval(disarm))

/**
 * What a quiet action in the rail just did, said in the rail, with the way
 * back. Dismiss is fully reversible, so it takes one press and offers Undo
 * rather than two presses every time: the same trade the tracker's status menu
 * makes. It moved into the More menu, where an arm-then-confirm cannot work
 * anyway, because the menu closes on the first press.
 */
const railNote = ref<{ text: string; undo?: () => void } | null>(null)

function dismiss() {
  const was = meta.value?.state
  const next = was === 'dismissed' ? 'new' : 'dismissed'
  const set = (state: string) => $fetch(`/api/postings/${id.value}/state`, { method: 'POST', body: { state } })
  return act('dismiss', () => set(next), () => {
    railNote.value = {
      text: next === 'dismissed' ? 'Dismissed. It has left the New list.' : 'Back in the New list.',
      undo: () => act('dismiss', () => set(was ?? 'new'), () => (railNote.value = null)),
    }
  })
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

// A built file is not recoverable, and it is chosen from a menu now, so the
// confirmation is a dialog that names the file rather than a second press on a
// trash icon 6px from the download.
const fileToDelete = ref<string | null>(null)
const fileDeleteOpen = computed({ get: () => fileToDelete.value !== null, set: (v) => { if (!v) fileToDelete.value = null } })

async function deleteFile() {
  const name = fileToDelete.value
  if (!name) return
  fileToDelete.value = null
  busy.value = 'file'
  try {
    await $fetch(`/api/postings/${id.value}/artifacts/${encodeURIComponent(name)}`, { method: 'DELETE' })
    await refresh()
    railNote.value = { text: `Deleted ${name}.` }
  } catch (err) {
    railNote.value = { text: `Could not delete ${name}: ${reason(err)}` }
  } finally {
    busy.value = ''
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
/**
 * career-ops's enum values and keys as words: `not_needed` -> "Not needed",
 * `ai_screening_disclosure` -> "AI screening disclosure". Only strings that are
 * plainly identifiers are touched (lowercase with underscores, or one bare
 * lowercase word); a sentence the evaluation wrote is left exactly as written.
 */
const ACRONYM: Record<string, string> = { ai: 'AI', jd: 'JD', cv: 'CV', na: 'n/a', us: 'US', api: 'API' }
function human(v: unknown): string {
  const raw = String(v ?? '').trim()
  if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(raw)) return raw
  if (ACRONYM[raw]) return ACRONYM[raw]!
  const words = raw.split('_').map((w) => ACRONYM[w] ?? w)
  return words.join(' ').replace(/^[a-z]/, (c) => c.toUpperCase())
}

function tone(v: unknown): string {
  const s = String(v ?? '').toLowerCase()
  if (!s) return 'var(--stone)'
  // A requirement he does not meet is a gap, not an unknown: it rendered in the
  // same neutral grey as "not assessed" and under-reported exactly what an
  // interviewer pushes on.
  if (/\bmissing\b|\babsent\b|not met|\bgap\b/.test(s)) return 'var(--danger)'
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
    .map((s) => ({ ...s, v: human(s.v), color: tone(s.v) }))
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
    match: r.match ? human(r.match) : '—',
    importance: r.importance ? human(r.importance) : '',
    evidence: r.evidence || '',
  })),
)

/**
 * The Evidence column only earns its place when it says something. The corpus
 * is mostly one bare word per row ("stated" on all twelve of a real posting),
 * which is a column of noise 70px wide; the screen-prep page drops anything
 * under 24 characters for the same reason.
 */
const showEvidence = computed(() => requirements.value.some((r) => r.evidence.trim().length >= 24))

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

/** What goes with the posting, naming only what exists: "0 built files" was a clause about nothing. */
const deleteParts = computed(() => {
  const m = meta.value
  if (!m) return ''
  const n = m.artifacts.length
  const parts = [
    m.hasJD ? 'its job description' : '',
    m.hasAnalysis ? 'the evaluation' : '',
    n ? (n === 1 ? '1 built file' : `${n} built files`) : '',
  ].filter(Boolean)
  if (!parts.length) return ''
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
})

/** Why there is no JD, as what to do about it rather than what the fetch returned. */
const jdWhy = computed(() => {
  const err = meta.value?.jdError
  if (!err) return 'Not fetched yet.'
  if (/LinkedIn/.test(err)) return 'LinkedIn would not hand it over this time. The Mac retries every half hour, so this usually fills in on its own.'
  if (/404|not found|closed|no longer/i.test(err)) return 'The posting could not be read, and it may have closed. Paste the description if you have it.'
  if (/block/i.test(err)) return `${err}. Paste the description if you have it.`
  return `It could not be read automatically (${err}). Try again, or paste it.`
})

/** With no evaluation, what the big number is and what happens next. */
const scanNote = computed(() => {
  const m = meta.value
  if (!m || analysis.value) return ''
  if (evalWaiting.value) return m.evalStatus === 'building' ? 'The Mac is evaluating this now.' : 'An evaluation is queued.'
  const scan = m.score === null ? 'No score yet' : 'This is the morning scan\'s quick score'
  // "On its way" only while that is believable: the worker runs hourly, so a
  // posting it has not reached in two hours is not about to be reached.
  const soon = evaluationExpected(m) && Date.now() - Date.parse(m.createdAt) < 2 * 3600_000
  return soon ? `${scan}. The full evaluation is on its way.` : `${scan}, not a full evaluation.`
})

const deleteNote = computed(() =>
  applied.value
    ? 'The Notion row and the funnel are untouched — this only removes the posting record here.'
    : 'The morning scan can push it back up if it scores again; Dismiss is the quieter option if you just want it out of the way.',
)

// Risk is folded into "everything else": three of its six rows restated the
// signal pills at the top of the page, in raw keys. It leads the list so it is
// the first thing there when he does open it.
const extras = computed(() =>
  [...Object.entries(analysis.value?.risk ?? {}), ...Object.entries(analysis.value?.extra ?? {})].map(([k, v]) => ({
    k: human(k),
    v: typeof v === 'string' ? human(v) : v,
  })),
)

// The letter's text is not a file to download; it is the Copy button under
// the files. It only shows as a card when there is no PDF beside it.
const letter = computed(() => letterText(meta.value?.artifacts ?? []))
const files = computed(() =>
  (meta.value?.artifacts ?? [])
    .filter((f) => f !== letter.value || !meta.value?.artifacts.some((a) => a.kind === 'cover-letter' && a !== f))
    .map((f) => ({
    ...f,
    label: KIND[f.kind] || f.name,
    icon: ICON[f.kind] ?? 'pi pi-file',
  })),
)

// ---- the rail (Posting Brief v3) ----
// In the order the work happens: read the posting, build the pack, record the
// application. The link to the posting is the one amber object. Recording an
// application is a quiet button that is always there, because he applies with
// or without a pack and the old rail only offered it once one was built.
const applied = computed(() => meta.value?.state === 'applied')
const dismissed = computed(() => meta.value?.state === 'dismissed')
const packDone = computed(() => meta.value?.pack === 'done')
const inFlight = computed(() => meta.value?.pack === 'requested' || meta.value?.pack === 'building')

// The pack test (shared/pack-test.ts): null when it does not decide this
// posting — no test running, or something already built, asked for or sent.
const testArm = computed(() =>
  meta.value && inPackTest(meta.value, data.value?.packTest ?? null) ? packArm(meta.value.id) : null,
)

const notionHref = computed(() =>
  meta.value?.notionPageId ? `https://notion.so/${meta.value.notionPageId.replace(/-/g, '')}` : '',
)

const shortUrl = (raw: string) => raw.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')

/** "Greenhouse" for a board it knows, the bare host for an employer's own site. */
function siteName(href: string): string {
  const channel = postingChannel(href)
  if (channel !== 'Company site') return channel
  try {
    return new URL(href).hostname.replace(/^www\./, '')
  } catch {
    return 'the site'
  }
}

/**
 * Where the amber button goes. The employer's own req when career-ops resolved
 * one, because that is the link that converts: applications sent on the
 * employer's page reach a screen about three times as often as ones sent
 * through the board. The board link then drops to a line underneath.
 */
const target = computed(() => {
  const m = meta.value
  if (!m) return null
  const href = m.employerUrl || m.url
  if (!href) return null
  return {
    href,
    name: siteName(href),
    short: shortUrl(href),
    foundOn: m.employerUrl && m.url ? { href: m.url, name: siteName(m.url) } : null,
  }
})

const applyHint = computed(() => {
  const where = target.value?.name ?? 'their site'
  if (armed.value === 'applied') return 'Press again to confirm. This writes the row into Notion.'
  if (applyNote.value) return applyNote.value.text
  if (testArm.value === 'base') return `Pack test: this one goes out with your base CV and no cover letter. Send it through ${where}, then record it here.`
  if (packDone.value) return `Once it is sent through ${where}. A row goes into Notion and the funnel picks it up within 5 minutes.`
  if (inFlight.value) return 'The pack is still building, but you can record an application any time.'
  return `Once it is sent through ${where}, with or without a pack.`
})

/** Two presses, like every other state change in the rail: this one writes to Notion. */
function onMarkApplied() {
  if (busy.value === 'applied') return
  if (armed.value !== 'applied') return arm('applied')
  disarmNow()
  return markApplied()
}

// ---- where the application stands, and changing it ----
//
// Once a posting is applied, this page was a dead end for its status: a
// rejection had to be marked from the dashboard's board, on a card he first
// had to find. The row is the same Notion application the board moves, so this
// uses the same composable and the same menu (useJobStatus().menuFor).
const idsMatch = (a: string, b: string) => a.replace(/-/g, '').toLowerCase() === b.replace(/-/g, '').toLowerCase()
const job = computed(() => {
  const pageId = meta.value?.notionPageId
  if (!pageId) return null
  return stats.value?.jobs.find((j) => idsMatch(j.id, pageId)) ?? null
})
const { busyId: statusBusy, toast: statusToast, menuFor: statusMenuFor, dismiss: dismissStatusToast } = useJobStatus()
const statusMenu = ref<any>(null)
const statusItems = computed(() => (job.value ? statusMenuFor(job.value) : []))
const statusLabel = computed(() => (job.value ? jobStatusLabel(job.value) : ''))
const statusClosed = computed(() => job.value?.bucket === 'rejected' || job.value?.bucket === 'offerDeclined' || job.value?.bucket === 'noAnswer')
const toggleStatus = (event: Event) => statusMenu.value?.toggle(event)

// ---- open questions the evaluation raised ----
const openAbout = computed(() => data.value?.open?.about ?? [])
const openEmployer = computed(() => data.value?.open?.employer ?? [])
const openLeft = computed(() => [...openAbout.value, ...openEmployer.value].filter((q) => !q.answeredAt).length)
// Offered, never done for him: a re-evaluation is a full run on the Mac.
const openSaved = ref(false)
// Saving one answer must not disturb the others. This used to refetch the
// posting, which swapped the whole page for its loading skeleton and threw away
// everything typed into the other boxes. The route returns the saved question,
// so it is patched in place. useFetch data is a shallow ref: replace, never edit.
function patchOpen(kind: 'about' | 'employer', change: (list: any[]) => any[]) {
  const d = data.value
  if (!d?.open) return
  data.value = { ...d, open: { ...d.open, [kind]: change(d.open[kind]) } }
}
function onOpenSaved(kind: 'about' | 'employer', q: { id: string }) {
  patchOpen(kind, (list) => list.map((x) => (x.id === q.id ? q : x)))
  openSaved.value = true
}
const openBulk = provideOpenQuestionBulk()
const onOpenRemoved = (kind: 'about' | 'employer', qid: string) => patchOpen(kind, (list) => list.filter((x) => x.id !== qid))

// ---- More: everything in the rail that is not a next step ----
const moreMenu = ref<any>(null)
const moreItems = computed(() => {
  const m = meta.value
  if (!m) return []
  const groups: any[] = [
    {
      label: 'This posting',
      items: [
        { label: dismissed.value ? 'Un-dismiss' : 'Dismiss', icon: 'pi pi-times', command: dismiss },
        ...(notionHref.value ? [{ label: 'Update the Notion page', icon: 'pi pi-sync', command: syncNotion }] : []),
      ],
    },
  ]
  if (m.artifacts.length) {
    groups.push({
      label: 'Built files',
      items: m.artifacts.map((f) => ({ label: `Delete ${f.name}…`, icon: 'pi pi-trash', command: () => (fileToDelete.value = f.name) })),
    })
  }
  groups.push({ separator: true }, { label: 'Delete posting…', icon: 'pi pi-trash', class: 'menu-danger', command: () => (deleteOpen.value = true) })
  return groups
})
const toggleMore = (event: Event) => moreMenu.value?.toggle(event)

// ---- next / previous, and the keys ----
const queue = usePostingQueue(() => id.value, allPostings)
const helpOpen = ref(false)

/** Keeps `?from=` so the back arrow still goes where he came from. */
function go(p: { id: string } | null) {
  if (p) navigateTo({ path: `/postings/${p.id}`, query: route.query })
}

// A different posting is a clean slate: nothing armed, no result from the last one.
watch(id, () => {
  disarmNow()
  dismissStatusToast()
  openSaved.value = false
  applyNote.value = null
  railNote.value = null
  notice.value = null
  note.value = ''
})

const SHORTCUTS: { keys: string; does: string }[] = [
  { keys: 'j / k', does: 'Next / previous posting' },
  { keys: 'o', does: 'Open the posting' },
  { keys: 'a', does: 'Mark as applied (press twice)' },
  { keys: 'b', does: 'Build the apply pack' },
  { keys: 'e', does: 'Evaluate, or re-evaluate' },
  { keys: 'q', does: 'Application questions' },
  { keys: 's', does: 'Screen prep' },
  { keys: 'x', does: 'Dismiss, or un-dismiss' },
  { keys: 'u', does: 'Back to where you came from' },
  { keys: '?', does: 'This list' },
]

useShortcuts({
  j: () => go(queue.next.value),
  k: () => go(queue.prev.value),
  o: () => { if (target.value) window.open(target.value.href, '_blank', 'noopener') },
  a: () => { if (!applied.value) onMarkApplied() },
  b: () => { buildOpen.value = true },
  e: () => { if (!evalWaiting.value) reEvalOpen.value = true },
  q: () => navigateTo(`/postings/${id.value}/questions?from=${parent.value}`),
  s: () => navigateTo(`/postings/${id.value}/screen?from=${parent.value}`),
  x: () => { dismiss() },
  u: () => navigateTo(parent.value),
  '?': () => { helpOpen.value = true },
})

const buildHint = computed(() =>
  testArm.value === 'base'
    ? 'Pack test: the base CV half. Building one takes this posting out of the test.'
    : testArm.value === 'tailored'
      ? 'Pack test: the tailored half.'
      : '',
)
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
        <!-- Next and previous through the list he came from. Client only: the
             view and sort are in localStorage. -->
        <ClientOnly>
          <nav v-if="queue.position.value" class="queue-nav" :aria-label="`Postings in ${queue.view.value.label}`">
            <span class="queue-pos">{{ queue.position.value }}</span>
            <button type="button" class="queue-btn" :disabled="!queue.prev.value" aria-label="Previous posting" title="Previous (k)" @click="go(queue.prev.value)">
              <i class="pi pi-angle-left" />
            </button>
            <button type="button" class="queue-btn" :disabled="!queue.next.value" aria-label="Next posting" title="Next (j)" @click="go(queue.next.value)">
              <i class="pi pi-angle-right" />
            </button>
            <button type="button" class="queue-btn queue-help" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" @click="helpOpen = true">?</button>
          </nav>
        </ClientOnly>
      </div>
    </header>

    <!-- Skeleton at the real dimensions, so nothing jumps (DESIGN.md §7.8) -->
    <!-- Only while there is nothing to show for this posting. A refetch of the
         one already on screen (a live update, any action's refresh) keeps the
         page mounted, so nothing he has typed is lost to a skeleton. -->
    <div v-if="pending && data?.meta?.id !== id" class="brief-grid" aria-busy="true" aria-label="Loading posting">
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

      <!--
        Four grid children in the order a phone should read them: the call, the
        rail, the evaluation, the job description. One left-column wrapper put
        the rail under the whole evaluation when stacked, which on a fully
        evaluated posting was 3,500px down. The better the posting, the further
        away the link to it.
      -->
      <main class="brief-grid" :class="{ 'no-eval': !analysis }">
          <!-- The call -->
          <PrimeCard class="sec brief-call" aria-label="The call">
            <template #content>
              <h2 class="sr-only">The call</h2>
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
                  <!-- No evaluation: say what the number is, and offer the
                       evaluation here, where it would be, rather than as a
                       footnote under Delete at the bottom of the rail. -->
                  <template v-if="!analysis">
                    <p class="scan-note">{{ scanNote }}</p>
                    <button v-if="!evalWaiting" type="button" class="rail-build first scan-eval" :disabled="busy === 'eval'" @click="reEvalOpen = true">
                      <i :class="busy === 'eval' ? 'pi pi-spin pi-spinner' : 'pi pi-sparkles'" />Evaluate now
                    </button>
                    <p v-if="meta.evalError" class="eval-error">Last evaluation failed: {{ meta.evalError }}</p>
                  </template>
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
                      <span class="dot" :style="{ background: t.color }" />{{ t.name }}<span class="sr-only">, {{ t.title }}</span>
                    </span>
                    <!-- The colours were explained only by a hover title, and a
                         phone has no hover. -->
                    <span v-if="stack.some((t) => t.assessed)" class="chip-key">coloured by how you match each in the requirements below</span>
                  </dd>
                </template>
              </dl>
            </template>
          </PrimeCard>

        <!-- The rail: what to do next, and what has been built -->
        <aside class="brief-rail" aria-label="Actions for this posting">
          <PrimeCard class="sec rail-card" aria-label="Application">
            <template #content>
              <div class="rail-head">
                <h2>Application</h2>
                <span class="rail-state" :class="{ on: applied && !statusClosed, closed: applied && statusClosed }">
                  <span class="dot" />
                  <template v-if="applied && job">{{ statusLabel }}</template>
                  <ClientOnly v-else-if="applied">Applied {{ when(meta.appliedAt) }}<template #fallback>Applied</template></ClientOnly>
                  <template v-else>{{ dismissed ? 'Dismissed' : 'Not applied yet' }}</template>
                </span>
              </div>

              <template v-if="target">
                <a class="rail-primary as-link" :href="target.href" target="_blank" rel="noopener">
                  <span>Open on {{ target.name }}</span><i class="pi pi-external-link" />
                </a>
                <p class="rail-url mono" :title="target.href">{{ target.short }}</p>
                <p v-if="target.foundOn || meta.postedAt || meta.location" class="rail-sub">
                  <template v-if="target.foundOn">
                    <template v-if="!applied">The employer's own posting, which is the better place to apply. </template>Found on
                    <a :href="target.foundOn.href" target="_blank" rel="noopener">{{ target.foundOn.name }}</a>.
                  </template>
                  <ClientOnly v-else>
                    <template v-if="meta.postedAt">posted {{ when(meta.postedAt) }}</template>
                    <template v-if="meta.postedAt && meta.location"> · </template>
                    <template v-if="meta.location">{{ meta.location }}</template>
                  </ClientOnly>
                </p>
              </template>

              <template v-if="!applied">
                <button
                  type="button"
                  class="rail-quiet"
                  :class="{ armed: armed === 'applied' }"
                  :disabled="busy === 'applied'"
                  aria-describedby="apply-hint"
                  @click="onMarkApplied"
                >
                  <i :class="busy === 'applied' ? 'pi pi-spin pi-spinner' : armed === 'applied' ? 'pi pi-check-circle' : 'pi pi-check'" />
                  <span>{{ busy === 'applied' ? 'Saving to Notion…' : armed === 'applied' ? 'Confirm applied' : 'Mark as applied' }}</span>
                  <span v-if="armed === 'applied'" class="armed-left mono" aria-hidden="true">{{ armedLeft }}s</span>
                </button>
                <p id="apply-hint" class="rail-hint" :class="armed !== 'applied' && applyNote ? 'is-' + applyNote.tone : ''" aria-live="polite">{{ applyHint }}</p>
              </template>
              <template v-else>
                <!-- A reply came in: say so here. The same menu as the board's. -->
                <button
                  v-if="job && canChangeStatus(job)"
                  type="button"
                  class="rail-quiet"
                  aria-haspopup="menu"
                  aria-controls="brief-status-menu"
                  :disabled="statusBusy === job.id"
                  @click="toggleStatus"
                >
                  <i :class="statusBusy === job.id ? 'pi pi-spin pi-spinner' : 'pi pi-flag'" />
                  <span>Update status</span>
                </button>
                <PrimeMenu id="brief-status-menu" ref="statusMenu" :model="statusItems" popup class="status-menu" />
                <p
                  class="rail-hint"
                  :class="statusToast ? (statusToast.error ? 'is-error' : 'is-ok') : applyNote ? 'is-' + applyNote.tone : ''"
                  aria-live="polite"
                >
                  <template v-if="statusToast">
                    {{ statusToast.text }}
                    <button v-if="statusToast.undo" type="button" class="linkish rail-undo" @click="statusToast.undo()">Undo</button>
                  </template>
                  <template v-else-if="applyNote">{{ applyNote.text }}</template>
                  <template v-else-if="job">
                    <ClientOnly>Applied {{ when(job.date || meta.appliedAt) }}.<template #fallback>Applied.</template></ClientOnly>
                    <template v-if="job.repliedAt"> First reply {{ job.repliedAt }}.</template>
                  </template>
                  <template v-else>
                    The funnel has not picked this up yet (its numbers are cached for 5 minutes). Its status can be updated here once it has.
                  </template>
                </p>
                <a v-if="notionHref" class="rail-quiet rail-quiet--link" :href="notionHref" target="_blank" rel="noopener">
                  <span>Open in Notion</span><i class="pi pi-external-link" />
                </a>
              </template>
            </template>
          </PrimeCard>

          <PrimeCard class="sec rail-card" aria-label="Apply pack">
            <template #content>
              <div class="rail-head">
                <h2>Apply pack</h2>
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
                </div>
              </div>
              <CopyCoverLetter v-if="letter" :posting-id="id" :name="letter.name" />
              <div v-if="testArm === 'base'" class="rail-files">
                <a class="file-card" href="/api/base-cv">
                  <i class="pi pi-file-pdf" />
                  <span class="file-meta">
                    <span class="file-label">Base CV · pack test</span>
                    <span class="file-sub mono">{{ data?.packTest?.name }} · {{ kb(data?.packTest?.bytes ?? 0) }}</span>
                  </span>
                  <i class="pi pi-download go" />
                </a>
              </div>
              <p v-else-if="!files.length" class="rail-empty">
                {{ inFlight ? 'The Mac is building it — it lands here when it is done.' : 'Nothing built yet.' }}
              </p>

              <p v-if="meta.pack === 'failed' && meta.packError" class="pack-error mono">{{ meta.packError }}</p>

              <button
                type="button"
                class="rail-build"
                :class="{ first: meta.pack === 'none' && testArm !== 'base' }"
                :disabled="busy === 'pack'"
                @click="buildOpen = true"
              >
                <i :class="busy === 'pack' ? 'pi pi-spin pi-spinner' : meta.pack === 'none' ? 'pi pi-file-plus' : 'pi pi-refresh'" />
                {{ testArm === 'base' ? 'Build anyway' : meta.pack === 'none' ? 'Build pack' : packDone ? 'Rebuild' : 'Restart the build' }}
              </button>
              <p v-if="buildHint" class="rail-hint">{{ buildHint }}</p>
              <ClientOnly>
                <p v-if="meta.packBuiltAt" class="faint mono built">
                  built {{ when(meta.packBuiltAt) }}<template v-if="meta.packNote"> · “{{ meta.packNote }}”</template>
                </p>
              </ClientOnly>
            </template>
          </PrimeCard>

          <!-- The supplemental questions a form asks, and their drafted answers. -->
          <NuxtLink class="link-card" :to="`/postings/${id}/questions?from=${parent}`">
            <span class="link-meta">
              <span class="link-title"><i class="pi pi-list-check" />Application questions</span><span class="sr-only">, </span>
              <span class="link-sub mono">
                <template v-if="meta.questions">{{ meta.answered }} of {{ meta.questions }} answered</template>
                <template v-else>none added yet</template>
              </span>
            </span>
            <i class="pi pi-angle-right go" />
          </NuxtLink>

          <!--
            First-call prep. Most applications that reach an interview stop at
            the first screen, so this is reachable from every posting, not only
            the ones with a booked call.
          -->
          <NuxtLink class="link-card" :to="`/postings/${id}/screen?from=${parent}`">
            <span class="link-meta">
              <span class="link-title"><i class="pi pi-comments" />Screen prep</span><span class="sr-only">, </span>
              <span class="link-sub mono">the first call, in your words</span>
            </span>
            <i class="pi pi-angle-right go" />
          </NuxtLink>

          <!-- Everything that is not a next step: dismiss, delete, the Notion
               page, a built file. One menu instead of a row of small buttons,
               with what it just did (and Undo) said beside it. -->
          <div class="rail-more">
            <p class="rail-note" aria-live="polite">
              <template v-if="railNote">
                {{ railNote.text }}
                <button v-if="railNote.undo" type="button" class="linkish rail-undo" @click="railNote.undo()">Undo</button>
              </template>
            </p>
            <button
              type="button"
              class="more-btn"
              aria-haspopup="menu"
              aria-controls="brief-more-menu"
              :disabled="busy === 'dismiss' || busy === 'file' || busy === 'notion'"
              @click="toggleMore"
            >
              <i :class="busy === 'dismiss' || busy === 'file' || busy === 'notion' ? 'pi pi-spin pi-spinner' : 'pi pi-ellipsis-h'" />More
            </button>
            <PrimeMenu id="brief-more-menu" ref="moreMenu" :model="moreItems" popup class="brief-more" />
          </div>

        </aside>

          <!-- The evaluation -->
          <PrimeCard v-if="analysis" class="sec brief-eval" aria-label="The evaluation">
            <template #content>
              <div class="eval-head">
                <h2>Evaluation</h2>
                <!-- Re-evaluate lives with the thing it replaces. It spends a
                     Claude run, so it is quiet: what you reach for when the
                     inputs changed, not a next step. -->
                <button type="button" class="linkish eval-again" :disabled="busy === 'eval' || evalWaiting" @click="reEvalOpen = true">
                  <i :class="busy === 'eval' || evalWaiting ? 'pi pi-spin pi-spinner' : 'pi pi-sparkles'" />
                  {{ evalWaiting ? (meta.evalStatus === 'building' ? 'Re-evaluating…' : 'Re-evaluation queued') : 'Re-evaluate' }}
                </button>
              </div>
              <p v-if="meta.evalError" class="eval-error">Last re-evaluation failed: {{ meta.evalError }}</p>
              <p v-if="analysis.nextAction" class="next-action">
                <i class="pi pi-flag" /><span>{{ analysis.nextAction }}</span>
              </p>

              <!-- What the evaluation could not settle, with somewhere to
                   answer it. Until 2026-10-09 the note above was all there
                   was: it asked, and nothing could reply. -->
              <template v-if="openAbout.length || openEmployer.length">
                <div class="eval-sec">
                  <h3>Open questions <span class="mono">· {{ openLeft ? `${openLeft} to answer` : 'all answered' }}</span></h3>
                  <NuxtLink to="/about-you" class="linkish oq-link">All questions</NuxtLink>
                </div>
                <div class="oq-list">
                  <OpenQuestionRow v-for="q in openAbout" :key="q.id" kind="about" :q="q" bare @saved="onOpenSaved('about', $event)" @removed="onOpenRemoved('about', $event)" />
                  <OpenQuestionRow v-for="q in openEmployer" :key="q.id" kind="employer" :q="q" bare @saved="onOpenSaved('employer', $event)" @removed="onOpenRemoved('employer', $event)" />
                </div>
                <OpenQuestionSaveAll :count="openBulk.count.value" :busy="openBulk.busy.value" :note="openBulk.note.value" @save="openBulk.saveAll" />
                <p v-if="openSaved" class="oq-after" role="status">
                  Saved. This evaluation was written without it.
                  <button type="button" class="linkish" :disabled="busy === 'eval' || evalWaiting" @click="reEvalOpen = true">Re-evaluate with your answer</button>
                </p>
              </template>

              <div v-if="findingRows.length" class="eval-sec">
                <h3>Findings <span class="mono">· {{ findSummary }}</span></h3>
              </div>
              <div class="table-scroll">
                <table class="findings-table">
                  <tbody>
                    <tr v-for="(f, i) in findingRows" :key="i" :class="{ 'group-end': f.last && i < findingRows.length - 1 }">
                      <td class="kind" :class="{ pt: f.first, pb: f.last, blank: !f.first }">
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
                  <span class="sec-note">what the JD asked for, and how you match</span>
                </div>
                <div class="table-scroll">
                  <table class="reqs-table">
                    <thead>
                      <tr>
                        <th>Requirement</th>
                        <th class="tight">Importance</th>
                        <th class="tight">Match</th>
                        <th v-if="showEvidence" class="tight">Evidence</th>
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
                        <td v-if="showEvidence" class="req-ev">{{ r.evidence || '—' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </template>

              <details v-if="extras.length" class="extras-toggle">
                <summary class="mono">risk, and everything else the report said · {{ extras.length }}</summary>
                <dl class="facts-grid lower">
                  <template v-for="e in extras" :key="e.k">
                    <dt class="low">{{ e.k }}</dt>
                    <dd>{{ e.v }}</dd>
                  </template>
                </dl>
              </details>
            </template>
          </PrimeCard>

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
                {{ jdWhy }}
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
      </main>

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
          <p v-if="testArm === 'base'" class="build-leave-test">
            This posting is in the base-CV half of the pack test. Building a pack takes it out of the
            test, and the comparison is only fair if that stays rare.
          </p>
          <p class="muted small">
            The Mac tailors a CV and cover letter to this JD and uploads them here. Builds have taken a median of about
            40 minutes (as short as 11, as long as 3 hours), and your phone is notified when it lands.
            A note steers the emphasis and tone.
          </p>
          <label>
            <span>Note for the build <small>optional</small></span>
            <PrimeTextarea
              v-model="note"
              autofocus
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
            :label="testArm === 'base' ? 'Build, leaving the test' : hardStops.length ? 'Build it anyway' : meta.pack === 'none' ? 'Build pack' : 'Rebuild'"
            icon="pi pi-refresh"
            size="small"
            :severity="hardStops.length || testArm === 'base' ? 'warning' : undefined"
            :loading="busy === 'pack'"
            @click="buildPack"
          />
        </template>
      </PrimeDialog>

      <PrimeDialog
        v-model:visible="reEvalOpen"
        modal
        :header="meta.hasAnalysis ? 'Re-evaluate this posting' : 'Evaluate this posting'"
        :style="{ width: 'min(520px, calc(100vw - 32px))' }"
      >
        <div class="build-dialog">
          <p class="muted small">
            The Mac re-reads the job description and writes a fresh A–G report, replacing the
            existing one in place. Usually a few minutes, and you get a notification.
          </p>
          <p v-if="meta.hasAnalysis" class="muted small">
            The evaluation below stays exactly as it is until the new one lands, so nothing is
            lost if the run fails.
          </p>
          <p v-if="!hasJD" class="build-stops">
            <span class="build-stops-head"><i class="pi pi-exclamation-triangle" /> There is no job description stored</span>
            <br>
            Without one the evaluation is written from the report and the Notion row, which is
            weaker than the first pass had. Paste the JD first if you have it.
          </p>
          <label>
            <span>What changed? <small>optional</small></span>
            <PrimeTextarea
              v-model="reEvalNote"
              rows="4"
              placeholder="e.g. the JD was pasted after the first pass, or the comp changed…"
              autocomplete="off"
            />
          </label>
        </div>
        <template #footer>
          <PrimeButton label="Cancel" severity="secondary" text size="small" @click="reEvalOpen = false" />
          <PrimeButton
            :label="meta.hasAnalysis ? 'Re-evaluate' : 'Evaluate'"
            icon="pi pi-sparkles"
            size="small"
            :loading="busy === 'eval'"
            @click="reEvaluate"
          />
        </template>
      </PrimeDialog>

      <!-- Delete: a modal rather than the arm-then-confirm used elsewhere.
           Not a browser dialog, so it does not block automation or screen
           readers — and unlike "Really delete?" it says what goes with it. -->
      <PrimeDialog
        v-model:visible="fileDeleteOpen"
        modal
        header="Delete this file?"
        :style="{ width: 'min(440px, calc(100vw - 32px))' }"
      >
        <div class="delete-dialog">
          <p>Removes <b>{{ fileToDelete }}</b> from this posting.</p>
          <p class="muted">It is not kept anywhere else on the site. Rebuilding the pack is the way to get it back.</p>
        </div>
        <template #footer>
          <PrimeButton label="Cancel" severity="secondary" text size="small" autofocus @click="fileToDelete = null" />
          <PrimeButton label="Delete file" icon="pi pi-trash" severity="danger" size="small" @click="deleteFile" />
        </template>
      </PrimeDialog>

      <PrimeDialog
        v-model:visible="helpOpen"
        modal
        header="Keyboard shortcuts"
        :style="{ width: 'min(420px, calc(100vw - 32px))' }"
      >
        <dl class="keys">
          <template v-for="k in SHORTCUTS" :key="k.keys">
            <dt class="mono">{{ k.keys }}</dt>
            <dd>{{ k.does }}</dd>
          </template>
        </dl>
        <p class="muted small keys-foot">
          j and k follow the list you last had open on the postings page ({{ queue.view.value.label }}). Keys are ignored
          while you are typing or a dialog is open, and Delete has none on purpose.
        </p>
      </PrimeDialog>

      <PrimeDialog
        v-model:visible="deleteOpen"
        modal
        header="Delete this posting?"
        :style="{ width: 'min(440px, calc(100vw - 32px))' }"
      >
        <div class="delete-dialog">
          <p>
            Removes <b>{{ meta.company }}<template v-if="meta.role"> · {{ meta.role }}</template></b>
            from postings<template v-if="deleteParts">, along with {{ deleteParts }}</template>.
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

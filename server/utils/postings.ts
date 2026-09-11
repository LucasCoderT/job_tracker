/**
 * Job postings: storage in the POSTINGS KV namespace, the id derivation the
 * producer shares, and the Machine Summary reader.
 *
 * One record per posting, keyed by a hash of its normalized URL:
 *   meta:<id>              PostingMeta (decision, pack progress, artifact index)
 *   jd:<id>                the job description, markdown — kept out of the meta
 *                          so listing stays small
 *   analysis:<id>          PostingAnalysis, career-ops's evaluation
 *   artifact:<id>:<name>   raw bytes — the tailored CV and cover letter
 *
 * A posting arrives thin from the morning scan and is upgraded in place when
 * a full evaluation exists, so every producer field is optional on write and
 * `state`/`pack`/artifacts are never clobbered by a push.
 */
import type {
  AnswerStatus,
  PostingAnalysis,
  PostingArtifact,
  PostingMeta,
  PostingPack,
  PostingQuestion,
  PostingQuestions,
  PostingState,
} from '../../shared/types'
import type { AppEnv, KVNamespace } from './notion'
import { normalizeUrl } from '../../shared/postings'

// Routes import it from here, as the pack routes import lint from utils/packs.
export { normalizeUrl } from '../../shared/postings'

export const POSTING_STATES: PostingState[] = ['new', 'dismissed', 'applied']
export const POSTING_PACKS: PostingPack[] = ['none', 'requested', 'building', 'done', 'failed']
export const ANSWER_STATUSES: AnswerStatus[] = ['none', 'requested', 'building', 'done', 'failed']

/** How many questions one application may carry. Forms are long; not this long. */
export const MAX_QUESTIONS = 40

/** How many artifacts one posting may hold, and how big each may be. */
export const MAX_ARTIFACTS = 12
export const MAX_ARTIFACT_BYTES = 6_000_000

const metaKey = (id: string) => `meta:${id}`
const jdKey = (id: string) => `jd:${id}`
const analysisKey = (id: string) => `analysis:${id}`
const artifactKey = (id: string, name: string) => `artifact:${id}:${name}`
const questionsKey = (id: string) => `questions:${id}`

export function postingsKV(env: AppEnv): KVNamespace | null {
  return env.POSTINGS ?? null
}

/** Ids are 16 lowercase hex from the producer; anything else is not ours. */
export function normalizePostingId(raw: string): string {
  const s = String(raw || '').trim().toLowerCase()
  return /^[0-9a-f]{16}$/.test(s) ? s : ''
}

/** The posting id: sha256 of the normalized URL, first 16 hex. */
export async function postingIdFor(url: string): Promise<string> {
  const key = normalizeUrl(url)
  if (!key) return ''
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

export function safeArtifactName(name: string): string {
  return String(name || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120)
}

/** What the file is, from its name — drives the icon and the ordering. */
export function artifactKind(name: string): PostingArtifact['kind'] {
  const n = name.toLowerCase()
  if (n.includes('cover')) return 'cover-letter'
  if (n.includes('cv') || n.includes('resume')) return 'cv'
  if (n.endsWith('.md') || n.endsWith('.txt')) return 'notes'
  return 'other'
}

// ---- KV ----

export async function listPostings(kv: KVNamespace): Promise<PostingMeta[]> {
  const metas: PostingMeta[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix: 'meta:', limit: 1000, cursor })
    const got = await Promise.all(page.keys.map((k) => kv.get(k.name, 'json')))
    for (const m of got) if (m) metas.push(m as PostingMeta)
    cursor = page.list_complete === false ? page.cursor : undefined
  } while (cursor)
  // Best first, then newest — the list is a ranked queue, not a log.
  metas.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.createdAt.localeCompare(a.createdAt))
  return metas
}

export async function getMeta(kv: KVNamespace, id: string): Promise<PostingMeta | null> {
  return ((await kv.get(metaKey(id), 'json')) as PostingMeta | null) ?? null
}

export async function putMeta(kv: KVNamespace, meta: PostingMeta): Promise<void> {
  await kv.put(metaKey(meta.id), JSON.stringify(meta))
}

export async function getJD(kv: KVNamespace, id: string): Promise<string | null> {
  return ((await kv.get(jdKey(id), 'text')) as string | null) ?? null
}

export async function putJD(kv: KVNamespace, id: string, jd: string): Promise<void> {
  await kv.put(jdKey(id), jd)
}

export async function getAnalysis(kv: KVNamespace, id: string): Promise<PostingAnalysis | null> {
  return ((await kv.get(analysisKey(id), 'json')) as PostingAnalysis | null) ?? null
}

export async function putAnalysis(kv: KVNamespace, id: string, analysis: PostingAnalysis): Promise<void> {
  await kv.put(analysisKey(id), JSON.stringify(analysis))
}

export async function getArtifact(
  kv: KVNamespace,
  id: string,
  name: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const meta = await getMeta(kv, id)
  const entry = meta?.artifacts.find((a) => a.name === name)
  if (!entry) return null
  const body = (await kv.get(artifactKey(id, name), 'arrayBuffer')) as ArrayBuffer | null
  return body === null ? null : { body, contentType: entry.contentType }
}

export async function putArtifact(
  kv: KVNamespace,
  meta: PostingMeta,
  name: string,
  body: ArrayBuffer,
  contentType: string,
): Promise<PostingMeta> {
  await kv.put(artifactKey(meta.id, name), body)
  const entry: PostingArtifact = {
    name,
    contentType,
    bytes: body.byteLength,
    kind: artifactKind(name),
    updatedAt: new Date().toISOString(),
  }
  const artifacts = meta.artifacts.filter((a) => a.name !== name).concat(entry)
  // CV, then cover letter, then notes — the order he reads them in.
  const rank = { cv: 0, 'cover-letter': 1, notes: 2, other: 3 } as const
  artifacts.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name))
  const next = { ...meta, artifacts, updatedAt: entry.updatedAt }
  await putMeta(kv, next)
  return next
}

export async function deleteArtifact(kv: KVNamespace, meta: PostingMeta, name: string): Promise<PostingMeta> {
  await kv.delete(artifactKey(meta.id, name))
  const next = {
    ...meta,
    artifacts: meta.artifacts.filter((a) => a.name !== name),
    updatedAt: new Date().toISOString(),
  }
  await putMeta(kv, next)
  return next
}

/** Meta last, so a crash leaves a recoverable record rather than orphans. */
export async function deletePosting(kv: KVNamespace, meta: PostingMeta): Promise<void> {
  await Promise.all(meta.artifacts.map((a) => kv.delete(artifactKey(meta.id, a.name))))
  await kv.delete(jdKey(meta.id))
  await kv.delete(analysisKey(meta.id))
  await kv.delete(questionsKey(meta.id))
  await kv.delete(metaKey(meta.id))
}

// ---- Application questions ----

/**
 * A stable id from the question text, so re-pasting the form does not orphan
 * the answers already drafted. Synchronous on purpose — this runs per question
 * on every write, and crypto.subtle would make the whole path async for a
 * value that never leaves this file.
 */
export function questionId(text: string): string {
  let h = 2166136261
  const s = text.trim().toLowerCase().replace(/\s+/g, ' ')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export const EMPTY_QUESTIONS = (stamp: string): PostingQuestions => ({
  questions: [],
  status: 'none',
  note: '',
  requestedAt: null,
  builtAt: null,
  error: null,
  updatedAt: stamp,
})

export async function getQuestions(kv: KVNamespace, id: string): Promise<PostingQuestions | null> {
  return ((await kv.get(questionsKey(id), 'json')) as PostingQuestions | null) ?? null
}

export async function putQuestions(kv: KVNamespace, id: string, q: PostingQuestions): Promise<void> {
  await kv.put(questionsKey(id), JSON.stringify(q))
}

/**
 * One question per line. Numbering, bullets and the trailing asterisk a form
 * uses to mark a field required are all noise he should not have to strip by
 * hand before pasting.
 */
export function parseQuestions(text: string): string[] {
  return String(text ?? '')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
        .replace(/\s*\*\s*$/, '')
        .trim(),
    )
    .filter((line) => line.length > 1)
    .slice(0, MAX_QUESTIONS)
}

/**
 * Merge a new question list over the stored one, carrying answers across by
 * id. Re-pasting a form with one question added must not discard the seven
 * answers already drafted.
 */
export function mergeQuestions(
  existing: PostingQuestion[],
  incoming: { question: string; answer?: string; source?: PostingQuestion['source'] }[],
  stamp: string,
): PostingQuestion[] {
  const byId = new Map(existing.map((q) => [q.id, q]))
  const out: PostingQuestion[] = []
  for (const item of incoming.slice(0, MAX_QUESTIONS)) {
    const question = str(item.question, 2000)
    if (!question) continue
    const id = questionId(question)
    const prev = byId.get(id)
    const answer = item.answer !== undefined ? str(item.answer, 20000) : (prev?.answer ?? '')
    const source = item.answer !== undefined ? (item.source ?? 'drafted') : (prev?.source ?? 'pasted')
    out.push({
      id,
      question,
      answer,
      source,
      updatedAt: prev && prev.answer === answer && prev.question === question ? prev.updatedAt : stamp,
    })
  }
  return out
}

/** The counts the list and the brief show without fetching the answers. */
export function withQuestionCounts(meta: PostingMeta, q: PostingQuestions | null): PostingMeta {
  return {
    ...meta,
    questions: q?.questions.length ?? 0,
    answered: q?.questions.filter((x) => x.answer.trim()).length ?? 0,
    answerStatus: q?.status ?? 'none',
  }
}

// ---- Producer input ----

const str = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max)

function strList(v: unknown, max = 40): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => str(x, 2000)).filter(Boolean).slice(0, max)
}

/** A score is 0–5 with one decimal, or nothing. Never coerce junk to 0. */
function score(v: unknown): number | null {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 5) return null
  return Math.round(n * 10) / 10
}

function salary(v: any): PostingMeta['salary'] {
  if (!v || typeof v !== 'object') return null
  const min = Number.isFinite(Number(v.min)) ? Number(v.min) : null
  const max = Number.isFinite(Number(v.max)) ? Number(v.max) : null
  if (min === null && max === null) return null
  return { min, max, currency: str(v.currency, 8) || null }
}

/**
 * Merge a producer push onto whatever is already stored. Present fields win,
 * absent fields keep their value — that is what lets the morning scan create
 * a thin record and a later evaluation fill it in without touching his
 * decision or the pack the Mac already built.
 */
export function mergePosting(id: string, existing: PostingMeta | null, body: any, stamp: string): PostingMeta {
  const has = (k: string) => body?.[k] !== undefined && body?.[k] !== null
  const pick = (k: string, fallback: string, max = 500) =>
    has(k) ? str(body[k], max) : fallback

  return {
    id,
    url: pick('url', existing?.url ?? '', 2000),
    company: pick('company', existing?.company ?? ''),
    role: pick('role', existing?.role ?? ''),
    location: pick('location', existing?.location ?? ''),
    source: pick('source', existing?.source ?? '', 60),
    score: has('score') ? score(body.score) : (existing?.score ?? null),
    why: pick('why', existing?.why ?? '', 2000),
    comp: pick('comp', existing?.comp ?? '', 200),
    geo: pick('geo', existing?.geo ?? '', 200),
    stack: pick('stack', existing?.stack ?? '', 200),
    salary: has('salary') ? salary(body.salary) : (existing?.salary ?? null),
    postedAt: has('postedAt') ? str(body.postedAt, 40) || null : (existing?.postedAt ?? null),
    firstSeen: has('firstSeen') ? str(body.firstSeen, 40) || null : (existing?.firstSeen ?? null),
    reportNum: has('reportNum') ? str(body.reportNum, 12) || null : (existing?.reportNum ?? null),

    // His decision and the Mac's progress are never set by a push.
    state: existing?.state ?? 'new',
    pack: existing?.pack ?? 'none',
    packNote: existing?.packNote ?? '',
    packError: existing?.packError ?? null,
    packRequestedAt: existing?.packRequestedAt ?? null,
    packBuiltAt: existing?.packBuiltAt ?? null,
    notionPageId: existing?.notionPageId ?? null,
    appliedAt: existing?.appliedAt ?? null,

    questions: existing?.questions ?? 0,
    answered: existing?.answered ?? 0,
    answerStatus: existing?.answerStatus ?? 'none',

    hasJD: has('jd') ? Boolean(str(body.jd, 200_000)) : (existing?.hasJD ?? false),
    hasAnalysis: has('analysis') ? Boolean(body.analysis) : (existing?.hasAnalysis ?? false),
    artifacts: existing?.artifacts ?? [],
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
  }
}

/**
 * Read a Machine Summary object into our shape. Enums stay free strings: the
 * real corpus spells legitimacy five ways ("High Confidence", "Legitimate",
 * a bare `1`) and risk seven, so anything stricter would drop a third of it.
 * Accepts both snake_case (career-ops's YAML) and camelCase.
 */
export function cleanAnalysis(raw: any): PostingAnalysis {
  const v = raw && typeof raw === 'object' ? raw : {}
  const get = (...keys: string[]) => {
    for (const k of keys) if (v[k] !== undefined && v[k] !== null) return v[k]
    return undefined
  }
  const opt = (...keys: string[]) => {
    const found = get(...keys)
    return found === undefined ? undefined : str(found, 2000) || undefined
  }
  const risk: Record<string, string> = {}
  const rawRisk = get('risk_summary', 'risk')
  if (rawRisk && typeof rawRisk === 'object') {
    for (const [k, val] of Object.entries(rawRisk).slice(0, 20)) {
      const text = str(val, 200)
      if (text) risk[str(k, 60)] = text
    }
  }
  const requirements = (Array.isArray(get('requirement_importance', 'requirements'))
    ? get('requirement_importance', 'requirements')
    : []
  )
    .slice(0, 40)
    .map((r: any) => ({
      requirement: str(r?.requirement, 1000),
      evidence: str(r?.evidence, 60) || undefined,
      importance: str(r?.importance, 60) || undefined,
      match: str(r?.match, 60) || undefined,
    }))
    .filter((r: any) => r.requirement)

  const confidential = get('company_confidential', 'companyConfidential')
  const via = get('via')

  // Anything not mapped above is carried through rather than dropped: the
  // report schema drifts, and a field this code has never heard of is far
  // more likely to be a new signal than noise.
  const MAPPED = new Set([
    'company', 'role', 'score', 'num', 'date', 'url', 'status',
    'final_decision', 'finalDecision', 'archetype', 'legitimacy_tier', 'legitimacy',
    'risk_level', 'riskLevel', 'confidence', 'work_auth', 'workAuth',
    'next_action', 'nextAction', 'advertised_comp', 'advertisedComp',
    'reports_to', 'reportsTo', 'via', 'company_confidential', 'companyConfidential',
    'hard_stops', 'hardStops', 'soft_gaps', 'softGaps', 'top_strengths', 'topStrengths',
    'discard_reasons', 'discardReasons', 'requirement_importance', 'requirements',
    'risk_summary', 'risk',
  ])
  const extra: Record<string, string> = {}
  for (const [k, val] of Object.entries(v).slice(0, 60)) {
    if (MAPPED.has(k) || val === null || val === undefined || val === '') continue
    const text = Array.isArray(val)
      ? val.map((x) => str(x, 200)).filter(Boolean).join(', ')
      : typeof val === 'boolean'
        ? (val ? 'yes' : 'no')
        : typeof val === 'object'
          ? ''
          : str(val, 1000)
    if (text) extra[str(k, 60)] = text
  }

  return {
    finalDecision: opt('final_decision', 'finalDecision'),
    archetype: opt('archetype'),
    legitimacy: opt('legitimacy_tier', 'legitimacy'),
    riskLevel: opt('risk_level', 'riskLevel'),
    confidence: opt('confidence'),
    workAuth: opt('work_auth', 'workAuth'),
    nextAction: opt('next_action', 'nextAction'),
    advertisedComp: opt('advertised_comp', 'advertisedComp'),
    reportsTo: opt('reports_to', 'reportsTo'),
    via: via === undefined || via === null ? null : str(via, 200) || null,
    companyConfidential: confidential === undefined ? undefined : Boolean(confidential),
    hardStops: strList(get('hard_stops', 'hardStops')),
    softGaps: strList(get('soft_gaps', 'softGaps')),
    topStrengths: strList(get('top_strengths', 'topStrengths')),
    discardReasons: strList(get('discard_reasons', 'discardReasons')),
    requirements,
    risk,
    extra,
  }
}

/**
 * Open questions, and what he answered.
 *
 * An evaluation that cannot settle something ends with a note: "Confirm with
 * Lucas whether he has any Kubernetes exposure beyond ECS". 106 of 308 reports
 * carried one, there was nowhere to answer it, and so the next evaluation asked
 * again. This is the place to answer, once.
 *
 * Two kinds, and the difference is who can answer:
 *
 *  - **about him**: his experience and preferences. Keyed by topic, so the same
 *    question from twelve postings is one row. The answer applies to every
 *    posting, past and future, and career-ops reads it before it evaluates or
 *    builds anything (`modes/_confirmed.md`, generated from GET /api/facts).
 *  - **for the employer**: the real salary band, whether Canada is eligible.
 *    His answer for one company says nothing about the next, so these belong
 *    to one posting.
 *
 * One KV document holds both. Every reader wants all of it (the Mac's sync, the
 * list page, the unanswered count), and one document is one read, which is the
 * rule the 2026-09-16 quota outage left behind.
 *
 * KV has no compare-and-set, so two writers can drop one change. The writers
 * are him and one sequential producer, and every write re-reads first, which
 * keeps that window to milliseconds.
 */
import type { EmployerQuestion, FactAsker, FactsDoc, FactVerdict, OpenQuestionInput, PostingOpenQuestions, ProfileQuestion } from '../../shared/types'
import type { KVNamespace } from './notion'
import { questionId } from './postings'

const KEY = 'facts:doc'
const MAX_TEXT = 4000
const VERDICTS: FactVerdict[] = ['yes', 'some', 'no']

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
/** Answers keep their line breaks: they are his writing. */
const cleanAnswer = (v: unknown) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT) : '')

/** "Kubernetes / container orchestration" and "kubernetes" are one topic only if written the same; the prompt is told to reuse ours. */
export const topicId = (topic: string) => questionId(`about:${topic.trim()}`)
export const employerQuestionId = (postingId: string, question: string) => questionId(`${postingId}:${question}`)

export async function readFacts(kv: KVNamespace): Promise<FactsDoc> {
  const doc = (await kv.get(KEY, 'json')) as FactsDoc | null
  return { updatedAt: doc?.updatedAt ?? null, about: doc?.about ?? [], employer: doc?.employer ?? [] }
}

async function writeFacts(kv: KVNamespace, doc: FactsDoc): Promise<FactsDoc> {
  const next = { ...doc, updatedAt: new Date().toISOString() }
  await kv.put(KEY, JSON.stringify(next))
  return next
}

export function forPosting(doc: FactsDoc, postingId: string): PostingOpenQuestions {
  return {
    about: doc.about.filter((q) => q.askedBy.some((a) => a.postingId === postingId)),
    employer: doc.employer.filter((q) => q.postingId === postingId),
  }
}

/**
 * Fold one posting's questions into the document. Pure, so it can be tested
 * and so the caller can skip the write when nothing changed.
 *
 * `replace` is for an evaluation, which states the posting's whole list: a
 * question the new evaluation no longer asks is taken off this posting. An
 * answered question is never removed by that. He answered it, and the answer
 * outlives the posting that prompted it. The backlog pass is additive.
 */
export function foldQuestions(doc: FactsDoc, asker: FactAsker, items: OpenQuestionInput[], replace: boolean, stamp: string): FactsDoc {
  const about = doc.about.map((q) => ({ ...q, askedBy: [...q.askedBy] }))
  let employer = [...doc.employer]
  const keptAbout = new Set<string>()
  const keptEmployer = new Set<string>()

  for (const raw of items.slice(0, 12)) {
    const question = clean(raw?.question, 600)
    if (!question) continue
    if (raw.about === 'employer') {
      const id = employerQuestionId(asker.postingId, question)
      keptEmployer.add(id)
      if (!employer.some((q) => q.id === id)) {
        employer.push({ id, postingId: asker.postingId, company: asker.company, role: asker.role, question, answer: null, answeredAt: null, createdAt: stamp })
      }
      continue
    }
    const topic = clean(raw?.topic, 80)
    if (!topic) continue
    const id = topicId(topic)
    keptAbout.add(id)
    let q = about.find((x) => x.id === id)
    if (!q) {
      q = { id, topic, question, answer: null, verdict: null, answeredAt: null, createdAt: stamp, askedBy: [] }
      about.push(q)
    }
    if (!q.askedBy.some((a) => a.postingId === asker.postingId)) q.askedBy.push(asker)
  }

  if (replace) {
    for (const q of about) {
      if (!keptAbout.has(q.id)) q.askedBy = q.askedBy.filter((a) => a.postingId !== asker.postingId)
    }
    employer = employer.filter((q) => q.postingId !== asker.postingId || keptEmployer.has(q.id) || q.answer)
  }
  // An unanswered question nobody asks any more is noise; an answered one is a fact.
  return { ...doc, about: about.filter((q) => q.askedBy.length || q.answer || q.verdict), employer }
}

const same = (a: FactsDoc, b: FactsDoc) => JSON.stringify([a.about, a.employer]) === JSON.stringify([b.about, b.employer])

/** Ingest from an evaluation or the backlog. Writes only when something changed: a producer re-pushes its whole corpus. */
export async function ingestQuestions(kv: KVNamespace, asker: FactAsker, items: OpenQuestionInput[], replace: boolean): Promise<boolean> {
  const doc = await readFacts(kv)
  const next = foldQuestions(doc, asker, items, replace, new Date().toISOString())
  if (same(doc, next)) return false
  await writeFacts(kv, next)
  return true
}

/** The evaluation's list, whatever shape the report gave it. `null` means the key was absent, which is not the same as an empty list. */
export function readOpenQuestions(analysis: any): OpenQuestionInput[] | null {
  const raw = analysis?.open_questions ?? analysis?.openQuestions
  if (!Array.isArray(raw)) return null
  return raw
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      about: /employer|company|recruiter/i.test(String(r.about ?? '')) ? ('employer' as const) : ('candidate' as const),
      topic: clean(r.topic, 80),
      question: clean(r.question, 600),
    }))
    .filter((r) => r.question)
}

function parseVerdict(v: unknown): FactVerdict | null {
  return VERDICTS.includes(v as FactVerdict) ? (v as FactVerdict) : null
}

/** His answer to a question about himself. An empty answer with no verdict clears it, back to unanswered. */
export async function answerAbout(kv: KVNamespace, id: string, body: any): Promise<ProfileQuestion | null> {
  const doc = await readFacts(kv)
  const q = doc.about.find((x) => x.id === id)
  if (!q) return null
  const answer = cleanAnswer(body?.answer)
  const verdict = parseVerdict(body?.verdict)
  q.answer = answer || null
  q.verdict = verdict
  q.answeredAt = answer || verdict ? new Date().toISOString() : null
  // Cleared and unasked: nothing left to keep.
  const next = { ...doc, about: doc.about.filter((x) => x.askedBy.length || x.answer || x.verdict) }
  await writeFacts(kv, next)
  return q
}

/** Something he wants evaluations to know that none has asked yet. */
export async function addAbout(kv: KVNamespace, body: any): Promise<ProfileQuestion | { error: string }> {
  const topic = clean(body?.topic, 80)
  const answer = cleanAnswer(body?.answer)
  const verdict = parseVerdict(body?.verdict)
  if (!topic) return { error: 'Give it a topic, a few words: "Kubernetes", "On-call".' }
  if (!answer && !verdict) return { error: 'Say what is true about it, or pick yes, some or no.' }
  const doc = await readFacts(kv)
  const id = topicId(topic)
  const stamp = new Date().toISOString()
  let q = doc.about.find((x) => x.id === id)
  if (!q) {
    q = { id, topic, question: clean(body?.question, 600) || `What is true about ${topic}?`, answer: null, verdict: null, answeredAt: null, createdAt: stamp, askedBy: [] }
    doc.about.push(q)
  }
  q.answer = answer || null
  q.verdict = verdict
  q.answeredAt = stamp
  await writeFacts(kv, doc)
  return q
}

export async function removeAbout(kv: KVNamespace, id: string): Promise<boolean> {
  const doc = await readFacts(kv)
  if (!doc.about.some((x) => x.id === id)) return false
  await writeFacts(kv, { ...doc, about: doc.about.filter((x) => x.id !== id) })
  return true
}

export async function answerEmployer(kv: KVNamespace, id: string, body: any): Promise<EmployerQuestion | null> {
  const doc = await readFacts(kv)
  const q = doc.employer.find((x) => x.id === id)
  if (!q) return null
  const answer = cleanAnswer(body?.answer)
  q.answer = answer || null
  q.answeredAt = answer ? new Date().toISOString() : null
  await writeFacts(kv, doc)
  return q
}

export async function removeEmployer(kv: KVNamespace, id: string): Promise<boolean> {
  const doc = await readFacts(kv)
  if (!doc.employer.some((x) => x.id === id)) return false
  await writeFacts(kv, { ...doc, employer: doc.employer.filter((x) => x.id !== id) })
  return true
}

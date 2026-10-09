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
 * Stored as two KV documents split by who writes them; the reason is further
 * down, under "Two writers, two documents".
 */
import type { EmployerQuestion, FactAsker, FactsDoc, FactVerdict, OpenQuestionInput, PostingOpenQuestions, ProfileQuestion } from '../../shared/types'
import type { KVNamespace } from './notion'
import { questionId } from './postings'

// Two documents, split by who writes them. See "Two writers, two documents".
const QUESTIONS_KEY = 'facts:questions'
const ANSWERS_KEY = 'facts:answers'
/** The single document both lived in until the afternoon of 2026-10-09. Read-only now. */
const LEGACY_KEY = 'facts:doc'
const MAX_TEXT = 4000
const VERDICTS: FactVerdict[] = ['yes', 'some', 'no']

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
/** Answers keep their line breaks: they are his writing. */
const cleanAnswer = (v: unknown) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT) : '')

/** "Kubernetes / container orchestration" and "kubernetes" are one topic only if written the same; the prompt is told to reuse ours. */
export const topicId = (topic: string) => questionId(`about:${topic.trim()}`)
export const employerQuestionId = (postingId: string, question: string) => questionId(`${postingId}:${question}`)

/**
 * Two writers, two documents.
 *
 * The first version kept questions and answers in one document. On its first
 * day he answered three questions within a minute of a batch of 51 questions
 * being added, and his save wrote back a copy of the document from before the
 * batch: the 51 were gone. "Re-read before every write" does not help, because
 * a KV read can be up to a minute stale at a colo that did not make the write
 * (the same trap CLAUDE.md records under the KV index).
 *
 * So the split is by writer, and neither can overwrite the other:
 *
 *  - `facts:questions` is written only by producers: an evaluation push, the
 *    backlog ingest, a posting being deleted. They run one at a time from the
 *    Mac.
 *  - `facts:answers` is written only by him. Each entry carries a copy of the
 *    question it answers, so an answer needs nothing from the other document
 *    to survive, and a tombstone is how "not a real question" hides one
 *    without touching the producers' list.
 *
 * readFacts() merges the two into the shape everything else uses.
 */
interface StoredAnswer {
  kind: 'about' | 'employer'
  id: string
  /** Hidden by him: "not a real question". Stays hidden if a later evaluation asks it again. */
  removed?: boolean
  topic?: string
  question: string
  postingId?: string
  company?: string
  role?: string
  answer: string | null
  verdict: FactVerdict | null
  answeredAt: string | null
}
interface AnswersDoc { updatedAt: string | null; items: Record<string, StoredAnswer> }
type QuestionsDoc = FactsDoc

const answerKey = (kind: 'about' | 'employer', id: string) => `${kind}:${id}`

async function readLegacy(kv: KVNamespace): Promise<FactsDoc | null> {
  return (await kv.get(LEGACY_KEY, 'json')) as FactsDoc | null
}

/** The producers' list, without answers. Falls back to the old single document until the first write. */
async function readQuestions(kv: KVNamespace): Promise<QuestionsDoc> {
  const doc = ((await kv.get(QUESTIONS_KEY, 'json')) as QuestionsDoc | null) ?? (await readLegacy(kv))
  return {
    updatedAt: doc?.updatedAt ?? null,
    about: (doc?.about ?? []).map((q) => ({ ...q, answer: null, verdict: null, answeredAt: null })),
    employer: (doc?.employer ?? []).map((q) => ({ ...q, answer: null, answeredAt: null })),
  }
}

async function readAnswers(kv: KVNamespace): Promise<AnswersDoc> {
  const doc = (await kv.get(ANSWERS_KEY, 'json')) as AnswersDoc | null
  if (doc) return { updatedAt: doc.updatedAt ?? null, items: doc.items ?? {} }
  // Before the split: lift the answers out of the old document.
  const legacy = await readLegacy(kv)
  const items: Record<string, StoredAnswer> = {}
  for (const q of legacy?.about ?? []) {
    if (q.answeredAt) items[answerKey('about', q.id)] = { kind: 'about', id: q.id, topic: q.topic, question: q.question, answer: q.answer, verdict: q.verdict, answeredAt: q.answeredAt }
  }
  for (const q of legacy?.employer ?? []) {
    if (q.answeredAt) items[answerKey('employer', q.id)] = { kind: 'employer', id: q.id, question: q.question, postingId: q.postingId, company: q.company, role: q.role, answer: q.answer, verdict: null, answeredAt: q.answeredAt }
  }
  return { updatedAt: legacy?.updatedAt ?? null, items }
}

/** Pure: the producers' questions with his answers laid over them. */
export function mergeFacts(questions: QuestionsDoc, answers: AnswersDoc): FactsDoc {
  const items = answers.items
  const about: ProfileQuestion[] = []
  const employer: EmployerQuestion[] = []
  const seen = new Set<string>()
  for (const q of questions.about) {
    const a = items[answerKey('about', q.id)]
    seen.add(answerKey('about', q.id))
    if (a?.removed) continue
    about.push({ ...q, answer: a?.answer ?? null, verdict: a?.verdict ?? null, answeredAt: a?.answeredAt ?? null })
  }
  for (const q of questions.employer) {
    const a = items[answerKey('employer', q.id)]
    seen.add(answerKey('employer', q.id))
    if (a?.removed) continue
    employer.push({ ...q, answer: a?.answer ?? null, answeredAt: a?.answeredAt ?? null })
  }
  // Answers whose question no producer lists any more: still his, still shown.
  for (const [key, a] of Object.entries(items)) {
    if (seen.has(key) || a.removed || !a.answeredAt) continue
    if (a.kind === 'about') {
      about.push({ id: a.id, topic: a.topic ?? a.question, question: a.question, answer: a.answer, verdict: a.verdict, answeredAt: a.answeredAt, createdAt: a.answeredAt, askedBy: [] })
    } else {
      employer.push({ id: a.id, postingId: a.postingId ?? '', company: a.company ?? '', role: a.role ?? '', question: a.question, answer: a.answer, answeredAt: a.answeredAt, createdAt: a.answeredAt })
    }
  }
  const stamps = [questions.updatedAt, answers.updatedAt].filter(Boolean) as string[]
  return { updatedAt: stamps.sort().pop() ?? null, about, employer }
}

export async function readFacts(kv: KVNamespace): Promise<FactsDoc> {
  const [questions, answers] = await Promise.all([readQuestions(kv), readAnswers(kv)])
  return mergeFacts(questions, answers)
}

/** Producers only. Answer fields are stripped: they live in the other document. */
async function writeQuestions(kv: KVNamespace, doc: FactsDoc): Promise<void> {
  const bare: QuestionsDoc = {
    updatedAt: new Date().toISOString(),
    about: doc.about.map((q) => ({ ...q, answer: null, verdict: null, answeredAt: null })),
    employer: doc.employer.map((q) => ({ ...q, answer: null, answeredAt: null })),
  }
  await kv.put(QUESTIONS_KEY, JSON.stringify(bare))
}

/** Him only. */
async function writeAnswers(kv: KVNamespace, doc: AnswersDoc): Promise<void> {
  await kv.put(ANSWERS_KEY, JSON.stringify({ ...doc, updatedAt: new Date().toISOString() }))
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

const bareOf = (d: FactsDoc) =>
  JSON.stringify([
    d.about.map((q) => [q.id, q.topic, q.question, q.askedBy]),
    d.employer.map((q) => [q.id, q.postingId, q.question]),
  ])

/**
 * A producer's read-change-write over the questions document. The fold sees
 * the merged view, so "keep it if he answered it" still works, but only the
 * questions are written back, and only when they changed: a producer re-pushes
 * its whole corpus.
 */
export async function updateQuestions(kv: KVNamespace, change: (doc: FactsDoc) => FactsDoc): Promise<{ changed: boolean; doc: FactsDoc }> {
  const [questions, answers] = await Promise.all([readQuestions(kv), readAnswers(kv)])
  // Merged without hiding tombstoned questions: a producer must not lose track
  // of a question just because he hid it.
  const visible = mergeFacts(questions, { ...answers, items: Object.fromEntries(Object.entries(answers.items).filter(([, a]) => !a.removed)) })
  const next = change(visible)
  const changed = bareOf(visible) !== bareOf(next)
  if (changed) await writeQuestions(kv, next)
  return { changed, doc: next }
}

/** Ingest from an evaluation. */
export async function ingestQuestions(kv: KVNamespace, asker: FactAsker, items: OpenQuestionInput[], replace: boolean): Promise<boolean> {
  const stamp = new Date().toISOString()
  return (await updateQuestions(kv, (doc) => foldQuestions(doc, asker, items, replace, stamp))).changed
}

/**
 * A posting was deleted: take it off what it asked. Its unanswered employer
 * questions go with it; an answered one stays, since he found that out.
 * career-ops deletes old postings in batches and most of them asked nothing,
 * so this writes only on a change.
 */
export async function forgetPosting(kv: KVNamespace, postingId: string): Promise<boolean> {
  return (
    await updateQuestions(kv, (doc) => ({
      ...doc,
      about: doc.about
        .map((q) => ({ ...q, askedBy: q.askedBy.filter((a) => a.postingId !== postingId) }))
        .filter((q) => q.askedBy.length || q.answer || q.verdict),
      employer: doc.employer.filter((q) => q.postingId !== postingId || q.answer),
    }))
  ).changed
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

/** One change to his document. Reads the answers only: nothing here can touch a producer's question. */
async function changeAnswers(kv: KVNamespace, change: (items: Record<string, StoredAnswer>) => void): Promise<void> {
  const doc = await readAnswers(kv)
  change(doc.items)
  await writeAnswers(kv, doc)
}

/** His answer to a question about himself. An empty answer with no verdict puts it back to unanswered. */
export async function answerAbout(kv: KVNamespace, id: string, body: any): Promise<ProfileQuestion | null> {
  const q = (await readFacts(kv)).about.find((x) => x.id === id)
  if (!q) return null
  const answer = cleanAnswer(body?.answer)
  const verdict = parseVerdict(body?.verdict)
  const answeredAt = answer || verdict ? new Date().toISOString() : null
  await changeAnswers(kv, (items) => {
    if (!answeredAt) delete items[answerKey('about', id)]
    else items[answerKey('about', id)] = { kind: 'about', id, topic: q.topic, question: q.question, answer: answer || null, verdict, answeredAt }
  })
  return { ...q, answer: answer || null, verdict, answeredAt }
}

/** Something he wants evaluations to know that none has asked yet. */
export async function addAbout(kv: KVNamespace, body: any): Promise<ProfileQuestion | { error: string }> {
  const topic = clean(body?.topic, 80)
  const answer = cleanAnswer(body?.answer)
  const verdict = parseVerdict(body?.verdict)
  if (!topic) return { error: 'Give it a topic, a few words: "Kubernetes", "On-call".' }
  if (!answer && !verdict) return { error: 'Say what is true about it, or pick yes, some or no.' }
  const id = topicId(topic)
  const existing = (await readFacts(kv)).about.find((x) => x.id === id)
  const stamp = new Date().toISOString()
  const q: ProfileQuestion = existing
    ? { ...existing, answer: answer || null, verdict, answeredAt: stamp }
    : { id, topic, question: clean(body?.question, 600) || `What is true about ${topic}?`, answer: answer || null, verdict, answeredAt: stamp, createdAt: stamp, askedBy: [] }
  await changeAnswers(kv, (items) => {
    items[answerKey('about', id)] = { kind: 'about', id, topic: q.topic, question: q.question, answer: q.answer, verdict, answeredAt: stamp }
  })
  return q
}

export async function answerEmployer(kv: KVNamespace, id: string, body: any): Promise<EmployerQuestion | null> {
  const q = (await readFacts(kv)).employer.find((x) => x.id === id)
  if (!q) return null
  const answer = cleanAnswer(body?.answer)
  const answeredAt = answer ? new Date().toISOString() : null
  await changeAnswers(kv, (items) => {
    if (!answeredAt) delete items[answerKey('employer', id)]
    else items[answerKey('employer', id)] = { kind: 'employer', id, question: q.question, postingId: q.postingId, company: q.company, role: q.role, answer, verdict: null, answeredAt }
  })
  return { ...q, answer: answer || null, answeredAt }
}

/**
 * Several answers in one write: "Save all". One read and one write of his
 * document however many boxes he filled in, where a save per box would be a
 * run of read-change-writes racing each other from the browser. An id that no
 * longer exists is skipped and counted; an item with nothing in it is skipped
 * too, since Save all must never blank an answer he did not touch.
 */
export async function answerMany(kv: KVNamespace, raw: unknown) {
  const list: any[] = Array.isArray(raw) ? raw.slice(0, 200) : []
  const doc = await readFacts(kv)
  const stamp = new Date().toISOString()
  const about: ProfileQuestion[] = []
  const employer: EmployerQuestion[] = []
  const writes: StoredAnswer[] = []
  let skipped = 0
  for (const it of list) {
    const id = String(it?.id ?? '')
    const answer = cleanAnswer(it?.answer)
    if (it?.kind === 'employer') {
      const q = doc.employer.find((x) => x.id === id)
      if (!q || !answer) { skipped++; continue }
      writes.push({ kind: 'employer', id, question: q.question, postingId: q.postingId, company: q.company, role: q.role, answer, verdict: null, answeredAt: stamp })
      employer.push({ ...q, answer, answeredAt: stamp })
    } else {
      const q = doc.about.find((x) => x.id === id)
      const verdict = parseVerdict(it?.verdict)
      if (!q || (!answer && !verdict)) { skipped++; continue }
      writes.push({ kind: 'about', id, topic: q.topic, question: q.question, answer: answer || null, verdict, answeredAt: stamp })
      about.push({ ...q, answer: answer || null, verdict, answeredAt: stamp })
    }
  }
  if (writes.length) {
    await changeAnswers(kv, (items) => {
      for (const w of writes) items[answerKey(w.kind, w.id)] = w
    })
  }
  return { about, employer, skipped }
}

/**
 * Remove, from his side. An answered question loses its answer and goes back
 * to being asked. An unanswered one is "not a real question": it gets a
 * tombstone, so it stays hidden even when a later evaluation asks it again.
 */
async function removeOne(kv: KVNamespace, kind: 'about' | 'employer', id: string): Promise<boolean> {
  const doc = await readFacts(kv)
  const q = (doc[kind] as (ProfileQuestion | EmployerQuestion)[]).find((x) => x.id === id)
  if (!q) return false
  await changeAnswers(kv, (items) => {
    const key = answerKey(kind, id)
    if (q.answeredAt) delete items[key]
    else items[key] = { kind, id, removed: true, question: q.question, answer: null, verdict: null, answeredAt: null }
  })
  return true
}
export const removeAbout = (kv: KVNamespace, id: string) => removeOne(kv, 'about', id)
export const removeEmployer = (kv: KVNamespace, id: string) => removeOne(kv, 'employer', id)

/**
 * First-call preparation.
 *
 * Of the ten applications that have ever reached an interview, **seven stopped
 * at the first screen** and none has produced an offer. Everything the site
 * builds — apply packs, drafted question answers, JD capture, the interview
 * pack itself — sits on one side or the other of that call. The screen is the
 * stage with no tooling pointed at it, and it is where the funnel actually
 * loses.
 *
 * Two kinds of prompt, and the difference is the whole design:
 *
 * - **Standing** — the six questions every screen opens with. Their answers do
 *   not change per company, so they *carry forward*: the last answer he wrote
 *   is what the next call starts from, marked `carried` until he revisits it.
 *   Without that he would retype "tell me about yourself" ten times and stop
 *   using this by the third.
 * - **Probe** — assembled from this posting's own evaluation. The hard stops
 *   and the high-importance requirements it recorded him as weak on are
 *   precisely what an interviewer pushes on, and they have been sitting in the
 *   analysis unread since the first push.
 *
 * **Nothing here writes his answers.** The prompts are questions and the
 * `because` lines are quoted from the evaluation; every answer is his, typed
 * here, exactly as the answer bank works. A screen is a conversation he has to
 * have in his own words, and a generated one would fail in the room.
 */
import type { KVNamespace } from './notion'
import type { PostingAnalysis, PostingMeta, ScreenPrep, ScreenPrompt, ScreenStanding } from '../../shared/types'
import { questionId } from './postings'

const prepKey = (id: string) => `screen:${id}`
const STANDING_KEY = 'screen:standing'

/** How many evaluation findings become probes. A call is 30 minutes. */
const MAX_PROBES = 5

/**
 * The questions a first call actually opens with.
 *
 * Deliberately short, and deliberately including the last one: a screen is as
 * often lost on "what questions do you have for us" as on anything technical,
 * because an unprepared answer there reads as indifference.
 */
export const STANDING_PROMPTS: { prompt: string; because: string }[] = [
  {
    prompt: 'Tell me about yourself.',
    because: 'The opener, every time. Sixty seconds, ending on why you are talking to them.',
  },
  {
    prompt: 'Why this company, and why this role?',
    because: 'Answered vaguely it reads as mass applying, which is the thing the screen is filtering for.',
  },
  {
    prompt: 'What are you looking for in salary?',
    because: 'Say the number plainly. Hedging here invites them to anchor it for you.',
  },
  {
    prompt: 'How did you get into engineering, and what have you been doing recently?',
    because: 'Self-taught is an answer, not an apology — and recent work is the strongest part of it.',
  },
  {
    prompt: 'Walk me through something you built end to end.',
    because: 'One system, start to finish, including what went wrong. This is the question the rest of the call is judged on.',
  },
  {
    prompt: 'What questions do you have for us?',
    because: 'Have three. Screens are lost here more often than anyone admits.',
  },
]

const clean = (s: unknown, max = 400) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

/**
 * What the evaluation says they will push on, hardest first: a hard stop is
 * something he has to have an answer for before the call is worth taking.
 */
export function probesFrom(analysis: PostingAnalysis | null): { prompt: string; because: string }[] {
  if (!analysis) return []
  const out: { prompt: string; because: string }[] = []

  for (const stop of (analysis as any).hardStops ?? []) {
    const text = clean(stop)
    if (text) out.push({ prompt: `Be ready for: ${text}`, because: 'Recorded as a hard stop on this posting.' })
  }

  for (const req of (analysis as any).requirements ?? []) {
    const importance = String(req?.importance ?? req?.requirement_importance ?? '').toLowerCase()
    const match = String(req?.match ?? req?.candidate_match ?? req?.status ?? '').toLowerCase()
    if (!/high|critical|must/.test(importance)) continue
    if (!/partial|no|miss|gap|weak|none/.test(match)) continue
    const name = clean(req?.requirement ?? req?.name ?? req?.skill, 160)
    if (!name) continue
    // The matrix's evidence column is free text and often degenerate — plenty
    // of rows say just "stated" or "partial", which tells him nothing on the
    // way into a call. Anything that short is dropped for the sentence that at
    // least explains why the prompt is here.
    const evidence = clean(req?.evidence ?? req?.note, 240)
    out.push({
      prompt: `How do you cover: ${name}?`,
      because:
        evidence.length > 24
          ? evidence
          : 'The evaluation rated this high-importance and your match partial.',
    })
  }

  for (const gap of (analysis as any).softGaps ?? []) {
    const text = clean(gap, 240)
    if (text) out.push({ prompt: `They may raise: ${text}`, because: 'Recorded as a gap on this posting.' })
  }

  // De-duplicate on the prompt text — a requirement often appears as both a
  // matrix row and a soft gap, phrased differently each time.
  const seen = new Set<string>()
  return out
    .filter((p) => {
      const key = p.prompt.toLowerCase().slice(0, 60)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, MAX_PROBES)
}

export async function getStanding(kv: KVNamespace): Promise<ScreenStanding> {
  const doc = (await kv.get(STANDING_KEY, 'json')) as ScreenStanding | null
  return doc && typeof doc.answers === 'object' ? doc : { answers: {}, updatedAt: '' }
}

export async function getPrep(kv: KVNamespace, id: string): Promise<ScreenPrep | null> {
  return ((await kv.get(prepKey(id), 'json')) as ScreenPrep | null) ?? null
}

/**
 * Assemble the prep for one call: what he has already written for this posting,
 * falling back to the standing answer from his last screen, falling back to
 * blank. Read-only — nothing is stored until he actually writes something.
 */
export async function buildPrep(
  kv: KVNamespace,
  meta: PostingMeta,
  analysis: PostingAnalysis | null,
): Promise<ScreenPrep> {
  const [saved, standing] = await Promise.all([getPrep(kv, meta.id), getStanding(kv)])
  const bySavedId = new Map((saved?.prompts ?? []).map((p) => [p.id, p]))

  const build = (kind: ScreenPrompt['kind']) => (src: { prompt: string; because: string }): ScreenPrompt => {
    const id = questionId(src.prompt)
    const mine = bySavedId.get(id)
    if (mine?.answer) return { ...mine, prompt: src.prompt, because: src.because, kind }
    const carried = kind === 'standing' ? standing.answers[id] : undefined
    return {
      id,
      prompt: src.prompt,
      because: src.because,
      kind,
      answer: carried?.answer ?? '',
      source: carried?.answer ? 'carried' : 'blank',
      updatedAt: mine?.updatedAt ?? carried?.updatedAt ?? '',
    }
  }

  return {
    prompts: [
      ...STANDING_PROMPTS.map(build('standing')),
      ...probesFrom(analysis).map(build('probe')),
    ],
    updatedAt: saved?.updatedAt ?? '',
  }
}

/**
 * Store one answer. A standing answer is also written to the standing document,
 * which is what the next call carries forward — so preparing for this screen
 * quietly improves the next one.
 */
export async function saveAnswer(
  kv: KVNamespace,
  meta: PostingMeta,
  analysis: PostingAnalysis | null,
  promptId: string,
  answer: string,
  stamp: string,
): Promise<ScreenPrep> {
  const prep = await buildPrep(kv, meta, analysis)
  const prompt = prep.prompts.find((p) => p.id === promptId)
  if (!prompt) throw new Error('unknown prompt')

  prompt.answer = String(answer ?? '').slice(0, 8000)
  prompt.source = 'edited'
  prompt.updatedAt = stamp
  prep.updatedAt = stamp

  await kv.put(prepKey(meta.id), JSON.stringify(prep))

  if (prompt.kind === 'standing') {
    const standing = await getStanding(kv)
    standing.answers[promptId] = { answer: prompt.answer, updatedAt: stamp }
    standing.updatedAt = stamp
    await kv.put(STANDING_KEY, JSON.stringify(standing))
  }
  return prep
}

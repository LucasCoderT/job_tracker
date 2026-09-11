/**
 * PUT /api/postings/:id/questions — replace the question list.
 *
 * Two callers, one route. He pastes the questions off the form (text, one per
 * line); the Mac uploads the drafted answers (`questions[]` with `answer`,
 * plus `?status=done`).
 *
 * Answers carry across by question id, so re-pasting a form with one question
 * added does not discard the seven answers already drafted.
 *
 * Body: { text?: string } | { questions: [{question, answer?}], note?, error? }
 */
import type { PostingQuestions } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import {
  getQuestions, putQuestions, putMeta, parseQuestions, mergeQuestions,
  withQuestionCounts, EMPTY_QUESTIONS, MAX_QUESTIONS,
} from '../../../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingQuestions> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const stamp = now()
  const existing = (await getQuestions(ctx.kv, ctx.id)) ?? EMPTY_QUESTIONS(stamp)

  const incoming = Array.isArray(body.questions)
    ? body.questions.map((q: any) => ({
        question: String(q?.question ?? ''),
        ...(q?.answer !== undefined ? { answer: String(q.answer), source: 'drafted' as const } : {}),
      }))
    : parseQuestions(String(body.text ?? '')).map((question) => ({ question }))

  if (!incoming.length && !String(body.text ?? '').trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Paste at least one question.' })
  }
  if (incoming.length > MAX_QUESTIONS) {
    throw createError({ statusCode: 413, statusMessage: `At most ${MAX_QUESTIONS} questions.` })
  }

  const done = getQuery(event).status === 'done'
  const next: PostingQuestions = {
    ...existing,
    questions: mergeQuestions(existing.questions, incoming, stamp),
    note: body.note !== undefined ? String(body.note).trim().slice(0, 2000) : existing.note,
    error: body.error ? String(body.error).slice(0, 2000) : done ? null : existing.error,
    updatedAt: stamp,
    ...(done ? { status: 'done' as const, builtAt: stamp, error: null } : {}),
  }

  await putQuestions(ctx.kv, ctx.id, next)
  await putMeta(ctx.kv, withQuestionCounts({ ...meta, updatedAt: stamp }, next))
  return next
})

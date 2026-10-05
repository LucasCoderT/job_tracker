/**
 * POST /api/postings/:id/questions/request — "Draft answers".
 *
 * Queues the Mac to answer the form's questions through career-ops's
 * modes/apply.md. Refused with nothing to answer: a queued draft of zero
 * questions would sit in the worker's queue forever looking like work.
 *
 * Body: { note?: string, only?: string[] }
 *
 * Without `only` the note steers the whole draft. With it, only those question
 * ids are drafted and the note is theirs alone: he liked answers 1 and 3 and
 * wants another go at 2, and a redraft of the form would replace all three.
 * The whole-draft note is left as it was.
 *
 *   - Tapping a second question while the first is still queued joins the run.
 *   - Once the Mac has started (building) a targeted request is refused: it is
 *     answering from the list it was given, and a target added now would be
 *     silently skipped.
 *   - A whole-form request always wins and clears the targets.
 */
import type { PostingQuestions } from '../../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../../utils/posting-route'
import { getQuestions, putQuestions, putMeta, withQuestionCounts, addTargets } from '../../../../utils/postings'
import { announce, commandWorkers } from '../../../../utils/realtime'

export default defineEventHandler(async (event): Promise<PostingQuestions> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const existing = await getQuestions(ctx.kv, ctx.id)
  if (!existing?.questions.length) {
    throw createError({ statusCode: 409, statusMessage: 'Paste the questions before asking for answers.' })
  }

  const note = body.note !== undefined ? String(body.note).trim().slice(0, 2000) : undefined
  const only: string[] | null = Array.isArray(body.only) ? [...new Set(body.only.map((x: unknown) => String(x)))] as string[] : null
  let targets: PostingQuestions['targets']
  if (only) {
    const known = new Set(existing.questions.map((q) => q.id))
    const ids = only.filter((qid) => known.has(qid))
    if (!ids.length) throw createError({ statusCode: 400, statusMessage: 'That question is not on this form any more.' })
    if (existing.status === 'building') {
      throw createError({ statusCode: 409, statusMessage: 'The Mac is drafting right now. Ask again when it finishes.' })
    }
    // A whole-form draft already queued covers this question too.
    if (existing.status === 'requested' && !existing.targets?.length) return existing
    targets = addTargets(existing.status === 'requested' ? existing.targets : [], ids, note ?? '')
  }

  const stamp = now()
  const next: PostingQuestions = {
    ...existing,
    status: 'requested',
    note: !only && note !== undefined ? note : existing.note,
    targets: targets ?? [],
    requestedAt: stamp,
    error: null,
    updatedAt: stamp,
  }
  await putQuestions(ctx.kv, ctx.id, next)
  await putMeta(ctx.kv, withQuestionCounts({ ...meta, updatedAt: stamp }, next))
  announce(event, 'answers.requested', ctx.id, {
    company: meta.company,
    role: meta.role,
    status: 'requested',
    questions: next.targets?.length || next.questions.length,
  })
  // Same trade as Build pack: the socket makes it about a second instead of
  // up to the worker's tick, and polling stays the fallback.
  commandWorkers(event, 'draft-answers', { id: ctx.id })
  return next
})

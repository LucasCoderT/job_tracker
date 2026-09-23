/**
 * POST /api/postings/:id/questions/preview — parse a paste, store nothing.
 *
 * Splitting a form into questions is a guess, however good the signal. A paste
 * with a code block and thirteen options can come out as one question or as
 * fourteen, and the difference is invisible until it is on screen. So the
 * parse is shown before it is saved, and the save is a separate decision.
 *
 * Body: { text }
 */
import type { ParsedQuestion } from '../../../../utils/postings'
import { postingContext, requirePosting } from '../../../../utils/posting-route'
import { parseQuestions } from '../../../../utils/postings'

export default defineEventHandler(async (event): Promise<{ questions: ParsedQuestion[] }> => {
  const ctx = postingContext(event)
  await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  return { questions: parseQuestions(String(body.text ?? '')) }
})

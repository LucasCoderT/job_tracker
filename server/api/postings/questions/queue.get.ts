/**
 * GET /api/postings/questions/queue — what the Mac should draft answers for.
 *
 * Requested first, then anything stuck in `building`, so a worker that died
 * mid-draft is picked up again — the same recovery the pack queue uses.
 *
 * A static segment, so it never collides with /api/postings/:id: a posting id
 * is 16 hex and "questions" is not.
 */
import type { PostingMeta, PostingQuestions } from '../../../../shared/types'
import { getCloudflareEnv } from '../../../utils/notion'
import { postingsKV, listPostings, getQuestions } from '../../../utils/postings'

export interface AnswerQueueEntry {
  posting: PostingMeta
  questions: PostingQuestions
}

export default defineEventHandler(async (event): Promise<{ enabled: boolean; entries: AnswerQueueEntry[] }> => {
  const kv = postingsKV(getCloudflareEnv(event))
  if (!kv) return { enabled: false, entries: [] }

  const wanted = (await listPostings(kv)).filter(
    (p) => p.answerStatus === 'requested' || p.answerStatus === 'building',
  )
  const entries: AnswerQueueEntry[] = []
  for (const posting of wanted) {
    const questions = await getQuestions(kv, posting.id)
    if (questions?.questions.length) entries.push({ posting, questions })
  }
  entries.sort((a, b) =>
    String(a.questions.requestedAt).localeCompare(String(b.questions.requestedAt)),
  )
  return { enabled: true, entries }
})

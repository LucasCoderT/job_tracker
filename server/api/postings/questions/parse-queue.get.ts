/**
 * GET /api/postings/questions/parse-queue — pastes waiting to be re-read.
 *
 * `building` is included so a worker that died leaves its work visible again,
 * the same rule the pack and answer queues use.
 */
import { getCloudflareEnv } from '../../../utils/notion'
import { postingsKV, listPostings, getQuestions } from '../../../utils/postings'
import type { PostingMeta, PostingQuestions } from '../../../../shared/types'

interface Entry {
  posting: PostingMeta
  rawText: string
  note: string
}

export default defineEventHandler(async (event): Promise<{ enabled: boolean; entries: Entry[] }> => {
  const kv = postingsKV(getCloudflareEnv(event))
  if (!kv) return { enabled: false, entries: [] }

  const wanted = (await listPostings(kv)).filter(
    (p) => p.parseStatus === 'requested' || p.parseStatus === 'building',
  )
  const entries: Entry[] = []
  for (const posting of wanted) {
    const q: PostingQuestions | null = await getQuestions(kv, posting.id)
    if (!q?.rawText) continue
    if (q.parseStatus !== 'requested' && q.parseStatus !== 'building') continue
    entries.push({ posting, rawText: q.rawText, note: q.note ?? '' })
  }
  return { enabled: true, entries }
})

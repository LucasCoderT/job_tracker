/**
 * GET /api/postings/queue — what the Mac should build a CV for: requested
 * packs first, then anything stuck in `building` (a worker that died
 * mid-build leaves it there; the next run picks it up again).
 */
import type { PostingsResponse } from '../../../shared/types'
import { getCloudflareEnv } from '../../utils/notion'
import { postingsKV, listPostings } from '../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingsResponse> => {
  const kv = postingsKV(getCloudflareEnv(event))
  if (!kv) return { enabled: false, postings: [] }
  const postings = (await listPostings(kv)).filter((p) => p.pack === 'requested' || p.pack === 'building')
  postings.sort((a, b) => String(a.packRequestedAt).localeCompare(String(b.packRequestedAt)))
  return { enabled: true, postings }
})

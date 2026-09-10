/** GET /api/postings — every posting, best score first. */
import type { PostingsResponse } from '../../../shared/types'
import { getCloudflareEnv } from '../../utils/notion'
import { postingsKV, listPostings } from '../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingsResponse> => {
  const kv = postingsKV(getCloudflareEnv(event))
  if (!kv) return { enabled: false, postings: [] }
  return { enabled: true, postings: await listPostings(kv) }
})

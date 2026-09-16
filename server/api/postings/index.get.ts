/** GET /api/postings — every posting, best score first. */
import type { PostingsResponse } from '../../../shared/types'
import { getCloudflareEnv } from '../../utils/notion'
import { postingsKV, listPostings } from '../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingsResponse> => {
  const kv = postingsKV(getCloudflareEnv(event))
  if (!kv) return { enabled: false, postings: [] }
  // `?fresh=1` rebuilds the listing index from the authoritative meta: keys —
  // the same escape hatch /api/stats gives for its edge cache, and the repair
  // for a listing that drifted. It costs a full scan; the default path is one read.
  const fresh = String(getQuery(event).fresh ?? '') === '1'
  return { enabled: true, postings: await listPostings(kv, { fresh }) }
})

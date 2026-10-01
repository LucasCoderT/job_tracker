/** GET /api/base-cv/info — whether the pack test is running, and since when. */
import type { PackTestInfo } from '../../../shared/types'
import { getCloudflareEnv } from '../../utils/notion'
import { postingsKV } from '../../utils/postings'
import { getPackTest } from '../../utils/pack-test'

export default defineEventHandler(async (event): Promise<PackTestInfo | null> => {
  const kv = postingsKV(getCloudflareEnv(event))
  return kv ? await getPackTest(kv) : null
})

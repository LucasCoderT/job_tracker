/** GET /api/packs — every pack's meta, newest first. */
import type { PacksResponse } from '../../../shared/types'
import { getCloudflareEnv } from '../../utils/notion'
import { packsKV, listPacks } from '../../utils/packs'

export default defineEventHandler(async (event): Promise<PacksResponse> => {
  const kv = packsKV(getCloudflareEnv(event))
  if (!kv) return { enabled: false, packs: [] }
  return { enabled: true, packs: await listPacks(kv) }
})

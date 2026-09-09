/**
 * GET /api/packs/queue — what the desktop worker should build: requested
 * packs first, then anything stuck in `building` (a worker that died
 * mid-build leaves it there; the next run picks it up again).
 */
import type { PacksResponse } from '../../../shared/types'
import { getCloudflareEnv } from '../../utils/notion'
import { packsKV, listPacks } from '../../utils/packs'

export default defineEventHandler(async (event): Promise<PacksResponse> => {
  const kv = packsKV(getCloudflareEnv(event))
  if (!kv) return { enabled: false, packs: [] }
  const packs = (await listPacks(kv)).filter((p) => p.status === 'requested' || p.status === 'building')
  packs.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
  return { enabled: true, packs }
})

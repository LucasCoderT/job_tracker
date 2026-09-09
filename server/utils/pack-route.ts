/**
 * Shared plumbing for the /api/packs routes: the KV handle (503 without the
 * binding), the normalized job id, and the meta-or-404. Access gates every
 * route at the edge — the app and the desktop worker arrive with a service
 * token — so, like the rest of the API, there is no auth code here.
 */
import type { H3Event } from 'h3'
import type { PackMeta } from '../../shared/types'
import { getCloudflareEnv, type AppEnv, type KVNamespace } from './notion'
import { packsKV, normalizeJobId, getMeta } from './packs'

export interface PackContext {
  env: AppEnv
  kv: KVNamespace
  jobId: string
}

export function packContext(event: H3Event): PackContext {
  const env = getCloudflareEnv(event)
  const kv = packsKV(env)
  if (!kv) throw createError({ statusCode: 503, statusMessage: 'No PACKS KV binding configured.' })
  const jobId = normalizeJobId(getRouterParam(event, 'jobId') ?? '')
  if (!jobId) throw createError({ statusCode: 400, statusMessage: 'Missing job id.' })
  return { env, kv, jobId }
}

export async function requireMeta(ctx: PackContext): Promise<PackMeta> {
  const meta = await getMeta(ctx.kv, ctx.jobId)
  if (!meta) throw createError({ statusCode: 404, statusMessage: 'No pack for this job yet.' })
  return meta
}

export const now = () => new Date().toISOString()

/**
 * Shared plumbing for the /api/postings routes: the KV handle (503 without
 * the binding), the validated posting id, and the meta-or-404. Access gates
 * every route at the edge — the site and the Mac's producer both arrive with
 * a service token — so, like the rest of the API, there is no auth code here.
 */
import type { H3Event } from 'h3'
import type { PostingMeta } from '../../shared/types'
import { getCloudflareEnv, type AppEnv, type KVNamespace } from './notion'
import { postingsKV, normalizePostingId, getMeta } from './postings'

export interface PostingContext {
  env: AppEnv
  kv: KVNamespace
  id: string
}

export function postingContext(event: H3Event): PostingContext {
  const env = getCloudflareEnv(event)
  const kv = postingsKV(env)
  if (!kv) throw createError({ statusCode: 503, statusMessage: 'No POSTINGS KV binding configured.' })
  const id = normalizePostingId(getRouterParam(event, 'id') ?? '')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'A posting id is 16 hex characters.' })
  return { env, kv, id }
}

export async function requirePosting(ctx: PostingContext): Promise<PostingMeta> {
  const meta = await getMeta(ctx.kv, ctx.id)
  if (!meta) throw createError({ statusCode: 404, statusMessage: 'No such posting.' })
  return meta
}

export const now = () => new Date().toISOString()

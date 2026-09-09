/**
 * POST /api/packs/:jobId/request — "Build pack" / "Regenerate".
 * Body: { company, position, note?, slug? }. Creates the meta on first
 * request; on a regenerate the previous bank stays readable until the
 * worker replaces it. The worker rebuilds from Notion, which is where web
 * edits were written, so a regenerate keeps them.
 */
import type { PackMeta } from '../../../../shared/types'
import { packContext, now } from '../../../utils/pack-route'
import { getMeta, getBank, putMeta, slugify, withCounts } from '../../../utils/packs'

export default defineEventHandler(async (event): Promise<PackMeta> => {
  const ctx = packContext(event)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const existing = await getMeta(ctx.kv, ctx.jobId)
  const company = String(body.company ?? existing?.company ?? '').trim()
  const position = String(body.position ?? existing?.position ?? '').trim()
  if (!company) throw createError({ statusCode: 400, statusMessage: 'A pack needs a company.' })
  const stamp = now()
  const meta: PackMeta = {
    jobId: ctx.jobId,
    company,
    position,
    slug: slugify(String(body.slug ?? existing?.slug ?? company)),
    status: 'requested',
    note: String(body.note ?? existing?.note ?? '').trim().slice(0, 2000),
    requestedAt: stamp,
    updatedAt: stamp,
    builtAt: existing?.builtAt ?? null,
    error: null,
    answers: existing?.answers ?? 0,
    beats: existing?.beats ?? 0,
    exports: existing?.exports ?? [],
  }
  const counted = withCounts(meta, await getBank(ctx.kv, ctx.jobId))
  await putMeta(ctx.kv, counted)
  return counted
})

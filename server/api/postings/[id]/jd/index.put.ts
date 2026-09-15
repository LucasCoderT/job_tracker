/**
 * PUT /api/postings/:id/jd — store a description fetched or pasted elsewhere.
 * Body: { text, source? }.
 *
 * Two callers. He pastes one on the brief for a source that will not be
 * fetched (Indeed) — source "pasted", and it replaces whatever is there, since
 * that is his call. And scripts/capture-jds.mjs on the Mac sends what
 * Cloudflare cannot reach: LinkedIn answers the Worker with 429 but answers a
 * home connection — source "linkedin", and like any capture it never replaces
 * a JD that is already stored.
 */
import type { PostingDetail } from '../../../../../shared/types'
import { postingContext, requirePosting } from '../../../../utils/posting-route'
import { getAnalysis, getJD } from '../../../../utils/postings'
import { storePastedJD } from '../../../../utils/jd-store'

export default defineEventHandler(async (event): Promise<PostingDetail> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const text = String(body.text ?? '').trim()
  if (text.length < 100) throw createError({ statusCode: 400, statusMessage: 'That is too short to be a job description.' })
  const source = String(body.source ?? 'pasted').trim().toLowerCase().slice(0, 30) || 'pasted'
  if (source !== 'pasted' && meta.hasJD) {
    return { meta, jd: await getJD(ctx.kv, ctx.id), analysis: await getAnalysis(ctx.kv, ctx.id) }
  }
  const res = await storePastedJD(ctx.env, ctx.kv, meta, text, source)
  return { meta: res.meta ?? meta, jd: res.jd, analysis: await getAnalysis(ctx.kv, ctx.id) }
})

/**
 * PUT /api/postings/:id — the producer pushing a posting up.
 *
 * An upsert, not a create: the morning scan writes a thin record and a later
 * evaluation fills in the analysis and the JD against the same id. Present
 * fields win, absent fields keep their value, and his decision (`state`) and
 * the Mac's progress (`pack`, artifacts) are never touched by a push — see
 * mergePosting.
 *
 * Body: { url, company, role, location?, source?, score?, why?, comp?, geo?,
 *         stack?, salary?, postedAt?, firstSeen?, reportNum?, jd?, analysis? }
 */
import type { PostingDetail } from '../../../../shared/types'
import { postingContext, now } from '../../../utils/posting-route'
import {
  getMeta, putMeta, getJD, putJD, getAnalysis, putAnalysis,
  mergePosting, cleanAnalysis, postingIdFor,
} from '../../../utils/postings'
import { MAX_JD, wantsCapture, captureForPosting, inBackground } from '../../../utils/jd-store'

export default defineEventHandler(async (event): Promise<PostingDetail> => {
  const ctx = postingContext(event)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const existing = await getMeta(ctx.kv, ctx.id)

  const url = String(body.url ?? existing?.url ?? '').trim()
  if (!url) throw createError({ statusCode: 400, statusMessage: 'A posting needs a url.' })
  if (!String(body.company ?? existing?.company ?? '').trim()) {
    throw createError({ statusCode: 400, statusMessage: 'A posting needs a company.' })
  }

  // The id IS the url — a mismatch means the producer and the Worker
  // disagree, and silently storing it would split the record in two.
  const derived = await postingIdFor(url)
  if (!derived) throw createError({ statusCode: 400, statusMessage: 'That url has no stable key.' })
  if (derived !== ctx.id) {
    throw createError({ statusCode: 409, statusMessage: `Id does not match the url (expected ${derived}).` })
  }

  const stamp = now()
  const meta = mergePosting(ctx.id, existing, body, stamp)

  // A producer re-pushes the same JD and the same analysis every time it
  // re-scans its reports, and writing bytes identical to the stored ones is
  // pure cost. Reads are abundant here and writes are the scarce meter — the
  // free plan allows 100,000 of one and 1,000 of the other — so comparing
  // first is the right trade by two orders of magnitude.
  if (typeof body.jd === 'string' && body.jd.trim()) {
    const next = body.jd.slice(0, MAX_JD)
    if ((await getJD(ctx.kv, ctx.id)) !== next) await putJD(ctx.kv, ctx.id, next)
    meta.hasJD = true
    // The archived JD from an evaluation is the best copy there is.
    meta.jdSource = 'career-ops'
    meta.jdCapturedAt = stamp
    meta.jdError = null
  } else {
    meta.hasJD = existing?.hasJD ?? false
  }

  if (body.analysis && typeof body.analysis === 'object') {
    const next = cleanAnalysis(body.analysis)
    const stored = await getAnalysis(ctx.kv, ctx.id)
    if (JSON.stringify(stored) !== JSON.stringify(next)) await putAnalysis(ctx.kv, ctx.id, next)
    meta.hasAnalysis = true
  } else {
    meta.hasAnalysis = existing?.hasAnalysis ?? false
  }

  // `existing` opts this path into skipping the index write when nothing a
  // queue or the notifier branches on has changed — which is every push, since
  // mergePosting will not let a producer touch state, pack or artifacts.
  await putMeta(ctx.kv, meta, existing)
  // No JD yet: fetch it from the posting after the response has gone, rather
  // than waiting for an evaluation that may never be run for this one.
  if (wantsCapture(meta)) inBackground(event, captureForPosting(ctx.env, ctx.kv, meta))
  const [jd, analysis] = await Promise.all([getJD(ctx.kv, ctx.id), getAnalysis(ctx.kv, ctx.id)])
  return { meta, jd, analysis }
})

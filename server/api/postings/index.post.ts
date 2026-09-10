/**
 * POST /api/postings — add a posting by URL, by hand.
 *
 * For the ones a friend sends that the morning scan will never find. The
 * client cannot compute the id (it is a hash of the normalized URL), so
 * unlike the producer's PUT this takes a bare URL and derives the id here.
 *
 * Company and role are optional: the evaluation worker fills them in from the
 * JD within the half hour, because a posting with no valid evaluation is
 * exactly what it drains. Until then the record is labelled with the URL's
 * host so it is recognisable in the list rather than blank.
 *
 * Body: { url, company?, role?, note? }
 */
import type { PostingCreateResult } from '../../../shared/types'
import { getCloudflareEnv, sourceDomain, channelOf } from '../../utils/notion'
import { postingsKV, getMeta, putMeta, postingIdFor, mergePosting } from '../../utils/postings'
import { now } from '../../utils/posting-route'

export default defineEventHandler(async (event): Promise<PostingCreateResult> => {
  const kv = postingsKV(getCloudflareEnv(event))
  if (!kv) throw createError({ statusCode: 503, statusMessage: 'No POSTINGS KV binding configured.' })

  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const url = String(body.url ?? '').trim()
  if (!url) throw createError({ statusCode: 400, statusMessage: 'Paste a job posting URL.' })

  const id = await postingIdFor(url)
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'That does not look like a job posting URL.' })
  }

  // Adding the same link twice is a normal thing to do — hand back what is
  // already there so the client can just open it, rather than erroring or
  // quietly resetting a posting he has already acted on.
  const existing = await getMeta(kv, id)
  if (existing) return { meta: existing, created: false }

  const stamp = now()
  const meta = mergePosting(id, null, {
    url,
    company: String(body.company ?? '').trim() || sourceDomain(url) || 'Unknown',
    role: String(body.role ?? '').trim(),
    source: channelOf(url) || sourceDomain(url) || 'manual',
    why: String(body.note ?? '').trim(),
    firstSeen: stamp.slice(0, 10),
  }, stamp)

  await putMeta(kv, meta)
  return { meta, created: true }
})

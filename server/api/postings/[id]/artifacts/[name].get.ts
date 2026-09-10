/**
 * GET /api/postings/:id/artifacts/:name — download a built file.
 *
 * `attachment`, not `inline` like a pack export: the whole point of this
 * route is getting the CV onto whatever device he is holding.
 */
import { postingContext } from '../../../../utils/posting-route'
import { getArtifact, safeArtifactName } from '../../../../utils/postings'

export default defineEventHandler(async (event) => {
  const ctx = postingContext(event)
  const name = safeArtifactName(getRouterParam(event, 'name') ?? '')
  const found = await getArtifact(ctx.kv, ctx.id, name)
  if (!found) throw createError({ statusCode: 404, statusMessage: 'No such file.' })
  setHeader(event, 'content-type', found.contentType)
  setHeader(event, 'content-disposition', `attachment; filename="${name}"`)
  setHeader(event, 'content-length', String(found.body.byteLength))
  return new Uint8Array(found.body)
})

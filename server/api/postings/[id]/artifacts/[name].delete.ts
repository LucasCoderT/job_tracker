/** DELETE /api/postings/:id/artifacts/:name — drop one built file. */
import type { PostingMeta } from '../../../../../shared/types'
import { postingContext, requirePosting } from '../../../../utils/posting-route'
import { deleteArtifact, safeArtifactName } from '../../../../utils/postings'

export default defineEventHandler(async (event): Promise<PostingMeta> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const name = safeArtifactName(getRouterParam(event, 'name') ?? '')
  if (!meta.artifacts.some((a) => a.name === name)) {
    throw createError({ statusCode: 404, statusMessage: 'No such file.' })
  }
  return deleteArtifact(ctx.kv, meta, name)
})

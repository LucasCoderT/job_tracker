/** DELETE /api/facts/employer/:id — remove the question and its answer. */
import { getCloudflareEnv } from '../../../utils/notion'
import { postingsKV, getMeta } from '../../../utils/postings'
import { removeEmployer } from '../../../utils/facts'

export default defineEventHandler(async (event) => {
  const kv = postingsKV(getCloudflareEnv(event))
  if (!kv) throw createError({ statusCode: 503, statusMessage: 'No POSTINGS KV binding configured.' })
  if (!(await removeEmployer(kv, getRouterParam(event, 'id') ?? ''))) throw createError({ statusCode: 404, statusMessage: 'No such question.' })
  return { ok: true }
})

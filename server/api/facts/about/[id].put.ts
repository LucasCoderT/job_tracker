/**
 * PUT /api/facts/about/:id — his answer. Body: { answer, verdict?: yes | some | no }
 * An empty answer puts the question back to unanswered.
 */
import { getCloudflareEnv } from '../../../utils/notion'
import { postingsKV, getMeta } from '../../../utils/postings'
import { answerAbout } from '../../../utils/facts'

export default defineEventHandler(async (event) => {
  const kv = postingsKV(getCloudflareEnv(event))
  if (!kv) throw createError({ statusCode: 503, statusMessage: 'No POSTINGS KV binding configured.' })
  const res = await answerAbout(kv, getRouterParam(event, 'id') ?? '', await readBody(event))
  if (!res) throw createError({ statusCode: 404, statusMessage: 'No such question.' })
  return res
})

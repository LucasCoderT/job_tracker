/**
 * POST /api/facts/about — something he wants evaluations to know that none has
 * asked yet. Body: { topic, answer?, verdict?, question? }
 */
import { getCloudflareEnv } from '../../../utils/notion'
import { postingsKV, getMeta } from '../../../utils/postings'
import { addAbout } from '../../../utils/facts'

export default defineEventHandler(async (event) => {
  const kv = postingsKV(getCloudflareEnv(event))
  if (!kv) throw createError({ statusCode: 503, statusMessage: 'No POSTINGS KV binding configured.' })
  const res = await addAbout(kv, await readBody(event))
  if ('error' in res) throw createError({ statusCode: 400, statusMessage: res.error })
  return res
})

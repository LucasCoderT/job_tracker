/**
 * PUT /api/facts/answers — several answers at once ("Save all").
 * Body: { items: [{ kind: 'about' | 'employer', id, answer?, verdict? }] }
 * Returns the saved questions, and how many items were skipped (an unknown id,
 * or nothing to save).
 */
import { getCloudflareEnv } from '../../utils/notion'
import { postingsKV } from '../../utils/postings'
import { answerMany } from '../../utils/facts'

export default defineEventHandler(async (event) => {
  const kv = postingsKV(getCloudflareEnv(event))
  if (!kv) throw createError({ statusCode: 503, statusMessage: 'No POSTINGS KV binding configured.' })
  const body = await readBody(event)
  return answerMany(kv, body?.items)
})

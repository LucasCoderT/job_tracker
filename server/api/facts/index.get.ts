/**
 * GET /api/facts — every open question and what he answered.
 *
 * The page reads it, and so does the Mac: career-ops turns this into
 * modes/_confirmed.md before it evaluates a posting or builds a pack, which is
 * how an answer given once reaches every later run.
 */
import type { FactsDoc } from '../../../shared/types'
import { getCloudflareEnv } from '../../utils/notion'
import { postingsKV, getMeta } from '../../utils/postings'
import { readFacts } from '../../utils/facts'

export default defineEventHandler(async (event): Promise<FactsDoc> => {
  const kv = postingsKV(getCloudflareEnv(event))
  if (!kv) throw createError({ statusCode: 503, statusMessage: 'No POSTINGS KV binding configured.' })
  return readFacts(kv)
})

/**
 * POST /api/facts/ingest — questions found in evaluations written before the
 * `open_questions` key existed.
 *
 * Body: { items: [{ postingId, about: 'candidate' | 'employer', topic?, question }] }
 *
 * Additive: it never takes a question off a posting, because it does not see
 * the posting's whole list the way a fresh evaluation does. A posting id the
 * site does not hold is skipped and counted.
 */
import type { OpenQuestionInput } from '../../../shared/types'
import { getCloudflareEnv } from '../../utils/notion'
import { postingsKV, getMeta } from '../../utils/postings'
import { foldQuestions, readFacts } from '../../utils/facts'

export default defineEventHandler(async (event) => {
  const kv = postingsKV(getCloudflareEnv(event))
  if (!kv) throw createError({ statusCode: 503, statusMessage: 'No POSTINGS KV binding configured.' })
  const body = await readBody(event)
  const items: any[] = Array.isArray(body?.items) ? body.items.slice(0, 500) : []
  const byPosting = new Map<string, OpenQuestionInput[]>()
  for (const it of items) {
    const id = String(it?.postingId ?? '').toLowerCase()
    if (!/^[0-9a-f]{16}$/.test(id)) continue
    if (!byPosting.has(id)) byPosting.set(id, [])
    byPosting.get(id)!.push({ about: it.about === 'employer' ? 'employer' : 'candidate', topic: it.topic, question: it.question })
  }

  let doc = await readFacts(kv)
  const before = JSON.stringify(doc)
  const stamp = new Date().toISOString()
  let skipped = 0
  for (const [postingId, list] of byPosting) {
    const meta = await getMeta(kv, postingId)
    if (!meta) {
      skipped++
      continue
    }
    doc = foldQuestions(doc, { postingId, company: meta.company, role: meta.role }, list, false, stamp)
  }
  // One write for the whole batch.
  if (JSON.stringify(doc) !== before) await kv.put('facts:doc', JSON.stringify({ ...doc, updatedAt: stamp }))
  return { ok: true, postings: byPosting.size - skipped, skipped, about: doc.about.length, employer: doc.employer.length }
})

/**
 * POST /api/jobs/replies — the Mac reporting when replies arrived.
 *
 * Body: { replies: [{ id, date, kind?, subject? }] }   (at most 20 per call)
 *
 * career-ops's reply-dates pass reads the "Work/job applications" mail folder,
 * classifies each message with the follow-up scanner's own rules, matches it to
 * an application, and sends the dates here. This route writes nothing but the
 * Replied column, and only ever moves it earlier: re-sending the whole history
 * is a no-op, which is what lets the backfill and the daily run be one path.
 *
 * Refused per row, never for the batch: a page outside DB Applications (the
 * same guard the status route has), a malformed date, and a reply dated before
 * the application, which is a matching mistake rather than a fast employer.
 *
 * Twenty because each row is a read and maybe a write, and a Worker's
 * subrequest budget is fifty on the free plan.
 */
import { getCloudflareEnv } from '../../utils/notion'
import { DATE_PROP } from '../../utils/config'
import { readApplication, readReplied, recordReply } from '../../utils/applications-notion'
import { purgeStats } from '../../utils/stats-cache'

const MAX = 20

interface ReplyResult {
  id: string
  outcome: 'written' | 'kept' | 'refused'
  replied: string | null
  reason?: string
}

export default defineEventHandler(async (event): Promise<{ results: ReplyResult[] }> => {
  const env = getCloudflareEnv(event)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const replies = Array.isArray(body.replies) ? body.replies : null
  if (!replies) throw createError({ statusCode: 400, statusMessage: 'Send { replies: [...] }.' })
  if (replies.length > MAX) throw createError({ statusCode: 413, statusMessage: `At most ${MAX} replies per call.` })

  const results: ReplyResult[] = []
  for (const r of replies) {
    const id = String(r?.id ?? '').replace(/-/g, '').toLowerCase()
    const date = String(r?.date ?? '')
    const refuse = (reason: string) => results.push({ id, outcome: 'refused', replied: null, reason })
    if (!/^[0-9a-f]{32}$/.test(id)) { refuse('not a Notion page id'); continue }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { refuse('date must be YYYY-MM-DD'); continue }

    try {
      const page = await readApplication(env, id)
      const applied = page.properties?.[DATE_PROP]?.date?.start?.slice(0, 10)
      if (applied && date < applied) { refuse(`reply ${date} is before the application ${applied}`); continue }
      const updated = await recordReply(env, page, date)
      results.push(updated
        ? { id, outcome: 'written', replied: readReplied(updated) }
        : { id, outcome: 'kept', replied: readReplied(page) })
    } catch (err: any) {
      refuse(String(err?.message || err).slice(0, 200))
    }
  }

  if (results.some((r) => r.outcome === 'written')) purgeStats(event)
  return { results }
})

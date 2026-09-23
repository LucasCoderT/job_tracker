/**
 * POST /api/postings/:id/link — point a posting at the Notion row it became.
 *
 * `applied` has always been a consequence of a Notion row existing rather than
 * a claim made without one, and that invariant holds here: the page is read
 * first and refused with 422 unless it really is a row in DB Applications, the
 * same check the status route makes. What this adds is the ability to say
 * *which* row, rather than having the site derive it.
 *
 * It exists for the historical backfill. `/reconcile` derives the link itself
 * from URLs and titles, which is right when nothing else knows the answer — but
 * the backfill has already matched a report to an application by exact company
 * and role, and re-deriving that match from weaker evidence could disagree with
 * the one it just made. A caller that knows the answer should be able to say it.
 *
 * `appliedAt` comes from Notion's own Application Date, never from now: it
 * feeds the EI week's candidate rows, and stamping today on an application from
 * May would propose an entry he never made in a document that has been audited.
 *
 * Body: { notionPageId }
 */
import type { PostingMeta } from '../../../../shared/types'
import { postingContext, requirePosting, now } from '../../../utils/posting-route'
import { putMeta } from '../../../utils/postings'
import { readApplication } from '../../../utils/applications-notion'
import { readDateMs } from '../../../utils/notion'

export default defineEventHandler(async (event): Promise<PostingMeta> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const notionPageId = String(body.notionPageId ?? '').trim()
  if (!notionPageId) throw createError({ statusCode: 400, statusMessage: 'Which Notion page?' })

  if (meta.notionPageId && meta.notionPageId !== notionPageId) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This posting is already linked to a different Notion page.',
    })
  }

  let page
  try {
    page = await readApplication(ctx.env, notionPageId)
  } catch (err: any) {
    throw createError({
      statusCode: err?.statusCode === 422 ? 422 : 502,
      statusMessage: String(err?.message ?? 'Notion refused the page.').slice(0, 200),
    })
  }

  const ms = readDateMs(page)
  const next: PostingMeta = {
    ...meta,
    state: 'applied',
    notionPageId,
    appliedAt: meta.appliedAt ?? (ms === null ? null : new Date(ms).toISOString()),
    updatedAt: now(),
  }
  await putMeta(ctx.kv, next)
  return next
})

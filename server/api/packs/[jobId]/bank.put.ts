/**
 * PUT /api/packs/:jobId/bank — replace the whole bank. The worker's upload
 * (`?status=done` marks the pack built in the same call) and the web
 * editor's bank-level saves (title, avoid list, deck) both land here.
 * Body: the bank JSON. Validated by the same rules as a card edit.
 *
 * Creates the pack if there isn't one. Uploading a bank for a job that was
 * never queued used to 404, which made a bank built on the Mac before the
 * site existed unreachable from the phone unless a build was requested first
 * purely to make somewhere to put it. Company and position come from the
 * bank's own title ("Acme — Senior Backend"), which is how InterviewHelper
 * names them.
 */
import type { PackDetail } from '../../../../shared/types'
import type { PackMeta } from '../../../../shared/types'
import { packContext, now } from '../../../utils/pack-route'
import { cleanBank, getMeta, putBank, putMeta, slugify, withCounts, lint } from '../../../utils/packs'

export default defineEventHandler(async (event): Promise<PackDetail> => {
  const ctx = packContext(event)
  let bank
  try {
    bank = cleanBank(await readBody(event))
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }

  const existing = await getMeta(ctx.kv, ctx.jobId)
  const [titleCompany = '', titlePosition = ''] = (bank.title ?? '').split(' — ')
  const meta: PackMeta = existing ?? {
    jobId: ctx.jobId,
    company: titleCompany.trim() || 'Unknown',
    position: titlePosition.trim(),
    slug: slugify(titleCompany.trim() || ctx.jobId),
    status: 'requested',
    note: '',
    requestedAt: now(),
    updatedAt: now(),
    builtAt: null,
    error: null,
    answers: 0,
    beats: 0,
    exports: [],
  }
  if (!bank.title) bank.title = `${meta.company}${meta.position ? ' — ' + meta.position : ''}`
  await putBank(ctx.kv, ctx.jobId, bank)
  const done = getQuery(event).status === 'done'
  const stamp = now()
  const next = withCounts(
    { ...meta, updatedAt: stamp, ...(done ? { status: 'done' as const, error: null, builtAt: stamp } : {}) },
    bank,
  )
  await putMeta(ctx.kv, next)
  return { meta: next, bank, lint: lint(bank) }
})

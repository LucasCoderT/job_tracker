/**
 * DELETE /api/packs/:jobId/answers/:answerId — drop a card from the pack.
 * Its Notion row is unticked (Active), never deleted, and only when it is
 * this application's own row. `?notion=0` skips Notion.
 */
import type { PackDetail, NotionWriteResult } from '../../../../../shared/types'
import { packContext, requireMeta, now } from '../../../../utils/pack-route'
import { getBank, putBank, putMeta, withCounts, lint, slugify } from '../../../../utils/packs'
import { retireAnswer } from '../../../../utils/bank-notion'

export default defineEventHandler(async (event): Promise<PackDetail & { notion: NotionWriteResult | null }> => {
  const ctx = packContext(event)
  const meta = await requireMeta(ctx)
  const id = slugify(getRouterParam(event, 'answerId') ?? '', 40)
  const bank = await getBank(ctx.kv, ctx.jobId)
  const answer = bank?.answers.find((a) => a.id === id)
  if (!bank || !answer) throw createError({ statusCode: 404, statusMessage: 'No such card in this pack.' })
  bank.answers = bank.answers.filter((a) => a.id !== id)
  if (bank.presentation) bank.presentation = bank.presentation.filter((s) => s.answerId !== id)
  await putBank(ctx.kv, ctx.jobId, bank)
  const next = withCounts({ ...meta, updatedAt: now() }, bank)
  await putMeta(ctx.kv, next)
  const notion = getQuery(event).notion === '0' ? null : await retireAnswer(ctx.env, ctx.jobId, answer)
  return { meta: next, bank, lint: lint(bank), notion }
})

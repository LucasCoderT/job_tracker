/**
 * PUT /api/packs/:jobId/answers/:answerId — save one card from the web.
 * Body: { answer, notion?: boolean } (notion defaults to true). The KV bank
 * is updated first — that is what the app imports — then the row in the
 * 🎤 Interview Answer Bank, whose outcome is reported, never fatal.
 */
import type { PackDetail, NotionWriteResult } from '../../../../../shared/types'
import { packContext, requireMeta, now } from '../../../../utils/pack-route'
import { cleanAnswer, getBank, putBank, putMeta, withCounts, lint, slugify } from '../../../../utils/packs'
import { writeAnswer } from '../../../../utils/bank-notion'

export default defineEventHandler(async (event): Promise<PackDetail & { notion: NotionWriteResult | null }> => {
  const ctx = packContext(event)
  const meta = await requireMeta(ctx)
  const routeId = slugify(getRouterParam(event, 'answerId') ?? '', 40)
  const body = (await readBody(event).catch(() => ({}))) ?? {}
  let answer
  try {
    answer = cleanAnswer({ ...(body.answer ?? body), id: body.answer?.id ?? body.id ?? routeId })
  } catch (err) {
    throw createError({ statusCode: 400, statusMessage: (err as Error).message })
  }
  const bank = (await getBank(ctx.kv, ctx.jobId)) ?? {
    title: `${meta.company}${meta.position ? ' — ' + meta.position : ''}`,
    answers: [],
  }
  // The route names the card being edited; a changed id in the body renames it.
  const index = bank.answers.findIndex((a) => a.id === routeId)
  if (index >= 0) bank.answers[index] = answer
  else {
    if (bank.answers.some((a) => a.id === answer.id)) {
      throw createError({ statusCode: 409, statusMessage: `A card with id "${answer.id}" already exists.` })
    }
    bank.answers.push(answer)
  }
  if (answer.id !== routeId && bank.presentation) {
    bank.presentation = bank.presentation.map((s) => (s.answerId === routeId ? { ...s, answerId: answer.id } : s))
  }
  await putBank(ctx.kv, ctx.jobId, bank)
  const next = withCounts({ ...meta, updatedAt: now() }, bank)
  await putMeta(ctx.kv, next)

  const notion = body.notion === false ? null : await writeAnswer(ctx.env, ctx.jobId, answer)
  return { meta: next, bank, lint: lint(bank), notion }
})

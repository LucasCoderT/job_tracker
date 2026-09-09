/**
 * PUT /api/packs/:jobId/exports/:name — the worker publishing a text export
 * (prep notes, a question bank, a debrief). Raw body; the Content-Type
 * header is kept and served back. Text only, 2MB cap: KV is not a file
 * store and a phone is the reader.
 */
import type { PackMeta } from '../../../../../shared/types'
import { packContext, requireMeta } from '../../../../utils/pack-route'
import { putExport, safeExportName } from '../../../../utils/packs'

const TYPES: Record<string, string> = {
  md: 'text/markdown;charset=utf-8',
  markdown: 'text/markdown;charset=utf-8',
  html: 'text/html;charset=utf-8',
  htm: 'text/html;charset=utf-8',
  json: 'application/json;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
}

export default defineEventHandler(async (event): Promise<PackMeta> => {
  const ctx = packContext(event)
  const meta = await requireMeta(ctx)
  const name = safeExportName(getRouterParam(event, 'name') ?? '')
  if (!name || name === 'bank.json' || name === 'prep.html') {
    throw createError({ statusCode: 400, statusMessage: 'Pick another export name.' })
  }
  const body = (await readRawBody(event, 'utf8')) ?? ''
  if (!body.trim()) throw createError({ statusCode: 400, statusMessage: 'Empty export.' })
  if (body.length > 2_000_000) throw createError({ statusCode: 413, statusMessage: 'Exports are capped at 2MB.' })
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const header = getHeader(event, 'content-type') ?? ''
  const contentType = TYPES[ext] ?? (header.startsWith('text/') || header.includes('json') ? header : 'text/plain;charset=utf-8')
  if (meta.exports.length >= 40 && !meta.exports.some((e) => e.name === name)) {
    throw createError({ statusCode: 409, statusMessage: 'A pack holds at most 40 exports.' })
  }
  return putExport(ctx.kv, meta, name, body, contentType)
})

/**
 * PUT /api/base-cv?name=<file.pdf> — upload the base CV. Raw PDF bytes.
 *
 * The first upload starts the pack test; replacing the file later keeps the
 * start date.
 */
import type { PackTestInfo } from '../../../shared/types'
import { getCloudflareEnv } from '../../utils/notion'
import { postingsKV, safeArtifactName, MAX_ARTIFACT_BYTES } from '../../utils/postings'
import { putBaseCv } from '../../utils/pack-test'

export default defineEventHandler(async (event): Promise<PackTestInfo> => {
  const kv = postingsKV(getCloudflareEnv(event))
  if (!kv) throw createError({ statusCode: 503, statusMessage: 'No POSTINGS binding.' })
  const name = safeArtifactName(String(getQuery(event).name ?? 'base-cv.pdf'))
  if (!/\.pdf$/i.test(name)) throw createError({ statusCode: 400, statusMessage: 'The base CV must be a PDF.' })
  const raw = await readRawBody(event, false)
  if (!raw?.length) throw createError({ statusCode: 400, statusMessage: 'Empty file.' })
  if (raw.length > MAX_ARTIFACT_BYTES) throw createError({ statusCode: 413, statusMessage: 'Files are capped at 6MB.' })
  if (String.fromCharCode(...raw.subarray(0, 4)) !== '%PDF') throw createError({ statusCode: 400, statusMessage: 'That is not a PDF.' })
  const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
  return putBaseCv(kv, name, bytes)
})

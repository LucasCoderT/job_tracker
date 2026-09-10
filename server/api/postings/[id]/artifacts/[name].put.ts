/**
 * PUT /api/postings/:id/artifacts/:name — the Mac publishing a built file.
 *
 * Binary, unlike a pack export: the deliverable here is a ~110KB PDF, not
 * markdown. Raw bytes in, 6MB cap, 12 files per posting — KV is not a file
 * store and a phone is the reader.
 */
import type { PostingMeta } from '../../../../../shared/types'
import { postingContext, requirePosting } from '../../../../utils/posting-route'
import { putArtifact, safeArtifactName, MAX_ARTIFACTS, MAX_ARTIFACT_BYTES } from '../../../../utils/postings'

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  md: 'text/markdown;charset=utf-8',
  markdown: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
  html: 'text/html;charset=utf-8',
  json: 'application/json;charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export default defineEventHandler(async (event): Promise<PostingMeta> => {
  const ctx = postingContext(event)
  const meta = await requirePosting(ctx)
  const name = safeArtifactName(getRouterParam(event, 'name') ?? '')
  if (!name) throw createError({ statusCode: 400, statusMessage: 'Pick a file name.' })

  const raw = await readRawBody(event, false)
  if (!raw || !raw.length) throw createError({ statusCode: 400, statusMessage: 'Empty file.' })
  if (raw.length > MAX_ARTIFACT_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Files are capped at 6MB.' })
  }
  if (meta.artifacts.length >= MAX_ARTIFACTS && !meta.artifacts.some((a) => a.name === name)) {
    throw createError({ statusCode: 409, statusMessage: `A posting holds at most ${MAX_ARTIFACTS} files.` })
  }

  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const header = (getHeader(event, 'content-type') ?? '').split(';')[0]!.trim()
  const contentType = TYPES[ext] ?? (header && header !== 'application/x-www-form-urlencoded' ? header : 'application/octet-stream')

  // Buffer → ArrayBuffer, sliced so a pooled Node buffer cannot hand KV more
  // than this body's own bytes.
  const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
  return putArtifact(ctx.kv, meta, name, bytes, contentType)
})

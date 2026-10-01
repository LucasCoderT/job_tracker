/** GET /api/base-cv — the base CV the pack test sends, as a download. */
import { getCloudflareEnv } from '../../utils/notion'
import { postingsKV, safeArtifactName } from '../../utils/postings'
import { getBaseCv, getPackTest } from '../../utils/pack-test'

export default defineEventHandler(async (event) => {
  const kv = postingsKV(getCloudflareEnv(event))
  const [info, body] = kv ? await Promise.all([getPackTest(kv), getBaseCv(kv)]) : [null, null]
  if (!info || !body) throw createError({ statusCode: 404, statusMessage: 'No base CV uploaded yet.' })
  const name = safeArtifactName(info.name || 'base-cv.pdf')
  setHeader(event, 'content-type', 'application/pdf')
  setHeader(event, 'content-disposition', `attachment; filename="${name}"`)
  setHeader(event, 'content-length', String(body.byteLength))
  return new Uint8Array(body)
})

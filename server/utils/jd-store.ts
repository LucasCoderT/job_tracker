/**
 * Capturing a posting's JD and keeping it — on the site, and on the Notion
 * application page once there is one.
 *
 * Two rules:
 *  - **A capture never overwrites a JD that is already there.** career-ops's
 *    archived JD (pushed with an evaluation) and one he pasted are both at
 *    least as good as a fresh scrape, and a posting that has since closed
 *    would replace a real description with an error page.
 *  - **The meta is re-read just before writing.** A capture runs in the
 *    background for a second or two after a push; writing back the copy it
 *    started with would undo anything he did to the posting meanwhile.
 */
import type { PostingMeta } from '../../shared/types'
import type { AppEnv, KVNamespace } from './notion'
import { getMeta, getJD, putJD, putMeta } from './postings'
import { captureJD, JdCaptureError } from './jd-capture'
import { syncApplicationPage } from './application-page'

export const MAX_JD = 200_000
const RETRY_AFTER_MS = 24 * 3_600_000

/** A push should try once a day at most for a posting that has no JD. */
export function wantsCapture(meta: PostingMeta, now = Date.now()): boolean {
  if (meta.hasJD) return false
  if (!meta.jdAttemptedAt) return true
  return now - Date.parse(meta.jdAttemptedAt) > RETRY_AFTER_MS
}

async function writeJdFields(kv: KVNamespace, id: string, fields: Partial<PostingMeta>): Promise<PostingMeta | null> {
  const fresh = await getMeta(kv, id)
  if (!fresh) return null // deleted while we were fetching
  const next = { ...fresh, ...fields }
  // JD provenance is display-only — nothing branches on it — so this skips the
  // index write unless the merge happened to move something that does.
  await putMeta(kv, next, fresh)
  return next
}

export interface StoredJD {
  meta: PostingMeta | null
  jd: string | null
  error: string | null
}

/** Fetch from the posting and store. Never throws: a failure is recorded on the meta. */
export async function captureForPosting(
  env: AppEnv,
  kv: KVNamespace,
  meta: PostingMeta,
  { sync = true }: { sync?: boolean } = {},
): Promise<StoredJD> {
  const stamp = new Date().toISOString()
  try {
    // The employer's own req when the resolver found one. This is the whole
    // reason an Indeed link is usable at all: Indeed cannot be read by anything
    // — HTTP fetch, headless Playwright and a direct fetch are all bounced to
    // bot detection — but the posting it points at can be, and resolve-employer-req
    // finds that from the company and role rather than from the page.
    const { text, source } = await captureJD(meta.employerUrl || meta.url)
    const already = await getJD(kv, meta.id)
    if (already) {
      const next = await writeJdFields(kv, meta.id, { hasJD: true, jdError: null, jdAttemptedAt: stamp })
      return { meta: next, jd: already, error: null }
    }
    await putJD(kv, meta.id, text.slice(0, MAX_JD))
    const next = await writeJdFields(kv, meta.id, {
      hasJD: true, jdSource: source, jdCapturedAt: stamp, jdError: null, jdAttemptedAt: stamp,
    })
    if (sync && next?.notionPageId) await syncApplicationPage(env, kv, next).catch(() => {})
    return { meta: next, jd: text, error: null }
  } catch (err) {
    const error = err instanceof JdCaptureError ? err.message : `capture failed: ${String((err as Error)?.message ?? err).slice(0, 160)}`
    const next = await writeJdFields(kv, meta.id, { jdError: error, jdAttemptedAt: stamp })
    return { meta: next, jd: null, error }
  }
}

/** Store a description obtained elsewhere — pasted by him, or fetched on the Mac. */
export async function storePastedJD(env: AppEnv, kv: KVNamespace, meta: PostingMeta, text: string, source = 'pasted'): Promise<StoredJD> {
  const stamp = new Date().toISOString()
  await putJD(kv, meta.id, text.slice(0, MAX_JD))
  const next = await writeJdFields(kv, meta.id, {
    hasJD: true, jdSource: source, jdCapturedAt: stamp, jdError: null, jdAttemptedAt: stamp,
  })
  if (next?.notionPageId) await syncApplicationPage(env, kv, next).catch(() => {})
  return { meta: next, jd: text, error: null }
}

/** Run a capture after the response has gone, when the platform allows it. */
export function inBackground(event: any, work: Promise<unknown>): void {
  const safe = work.catch(() => {})
  const ctx = event?.context?.cloudflare?.context
  if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(safe)
}

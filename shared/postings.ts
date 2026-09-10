/**
 * Posting helpers shared by the Worker and the browser — the same role
 * shared/bank.ts plays for packs.
 *
 * normalizeUrl is a port of career-ops's url-key.mjs, the canonical posting
 * key on that side. Keeping it here means the Worker derives ids with it and
 * the browser can use it to spot a posting that is already in the tracker,
 * without either re-deriving the rules.
 */

const TRACKING_PARAMS = [
  /^utm_/i, /^gh_src$/i, /^fbclid$/i, /^gclid$/i,
  /^mc_cid$/i, /^mc_eid$/i, /^igshid$/i, /^_hsenc$/i, /^_hsmi$/i, /^trk$/i, /^trackingid$/i,
]

/**
 * The stable key for a posting URL: https, lowercased host, no fragment, no
 * tracking params, sorted query, no trailing slash.
 *
 * Returns '' for anything that is not a real http(s) URL — and '' means NO
 * KEY, so it must never be treated as equal to another ''. Callers skip
 * those rather than storing or joining on them.
 */
export function normalizeUrl(raw: string): string {
  const s = String(raw || '').trim()
  if (!s) return ''
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return ''
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
  u.protocol = 'https:'
  u.hostname = u.hostname.toLowerCase()
  u.hash = ''
  const keep: [string, string][] = []
  for (const [k, v] of u.searchParams.entries()) {
    if (!TRACKING_PARAMS.some((re) => re.test(k))) keep.push([k, v])
  }
  keep.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  u.search = ''
  for (const [k, v] of keep) u.searchParams.append(k, v)
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1)
  return u.toString()
}

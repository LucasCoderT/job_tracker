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

/**
 * The board a posting came from, from its URL.
 *
 * Lives here rather than in server/utils/notion.ts because the postings list
 * filters on it in the browser: a posting's stored `source` is free-text
 * provenance from career-ops ("linkedin 4461192634", "ats-full:greenhouse-full",
 * "Lever board enumeration"), which is 34 distinct values across 37 rows and
 * useless as a filter. The URL is the authoritative answer.
 */
export function sourceDomain(url: string | null): string | null {
  if (!url) return null
  try {
    const host = new URL(url).hostname.toLowerCase()
    const parts = host.split('.')
    return parts.length > 2 ? parts.slice(-2).join('.') : host
  } catch {
    return null
  }
}

const CHANNEL_BY_DOMAIN: Record<string, string> = {
  'linkedin.com': 'LinkedIn',
  'indeed.com': 'Indeed',
  'remoteok.com': 'RemoteOK',
  'ashbyhq.com': 'Ashby',
  'greenhouse.io': 'Greenhouse',
  'lever.co': 'Lever',
  'myworkdayjobs.com': 'Workday',
  'myworkdaysite.com': 'Workday',
  'rippling.com': 'Rippling',
  'breezy.hr': 'Breezy',
  'wellfound.com': 'Wellfound',
  'angel.co': 'Wellfound',
  'jobbank.gc.ca': 'Job Bank',
  'hrsdc-rhdcc.gc.ca': 'Job Bank',
}

export function channelOf(url: string | null): string | null {
  const domain = sourceDomain(url)
  if (!domain) return null
  const known = channelForHost(url)
  return known ?? domain
}

/**
 * Match on the whole hostname, not the registrable domain. sourceDomain keeps
 * only the last two labels, so "www.jobbank.gc.ca" became "gc.ca" and never
 * matched the 'jobbank.gc.ca' key — every Job Bank posting was labelled
 * "gc.ca", here and in the dashboard's sources chart.
 */
function channelForHost(url: string | null): string | null {
  let host = ''
  try {
    host = new URL(String(url)).hostname.toLowerCase()
  } catch {
    return null
  }
  for (const [domain, channel] of Object.entries(CHANNEL_BY_DOMAIN)) {
    if (host === domain || host.endsWith('.' + domain)) return channel
  }
  // A company's own careers page is often just an ATS in a costume; the board
  // that actually holds the posting is in the query string.
  try {
    const q = new URL(String(url)).searchParams
    if (q.has('gh_jid') || q.has('gh_src')) return 'Greenhouse'
    if (q.has('ashby_jid')) return 'Ashby'
  } catch {
    /* not a URL */
  }
  return null
}

/**
 * The high-level board, for filtering. Anything that is not a board he applies
 * through repeatedly is "Company site" — otherwise every direct application
 * becomes its own filter option, which is what made the old filter useless.
 * The company itself is in the next column, so the domain adds nothing.
 */
export function postingChannel(url: string | null): string {
  return channelForHost(url) ?? 'Company site'
}

/**
 * Whether a posting is local, and how local.
 *
 * Geography is a *gate* in career-ops (`queue-from-digests.mjs` rejects a
 * Canadian office role unless it is remote or Edmonton-area) and nothing
 * downstream ever ranked by it. But the deepest process in the funnel —
 * Stantec, the only one to reach a third round from an employer's own site —
 * is Edmonton and in-office, and the pipeline weighted that profile at zero.
 *
 * Derived from the strings the producer already sends rather than stored, so
 * there is no field to migrate and no second source of truth. It reads both
 * `location` and `geo` because producers fill one or the other depending on
 * which scan found the posting.
 */
export type Locality = 'edmonton' | 'alberta' | 'remote-canada' | 'canada' | 'elsewhere' | 'unknown'

export function localityOf(location?: string | null, geo?: string | null): Locality {
  const s = `${location ?? ''} ${geo ?? ''}`.toLowerCase()
  if (!s.trim()) return 'unknown'

  const edmonton = /\bedmonton\b|\byeg\b|\bst\.?\s*albert\b|\bsherwood park\b|\bleduc\b/.test(s)
  const alberta = /\balberta\b|\bcalgary\b|\bab\b(?![a-z])/.test(s)
  const canadian =
    /\bcanada\b|\bcanadian\b|\bontario\b|\bquebec\b|\bbritish columbia\b|\bvancouver\b|\btoronto\b|\bmontreal\b|\bottawa\b/.test(s) ||
    edmonton ||
    alberta

  // Remote wins over the city name, because plenty of remote-Canada postings
  // merely *list* an office — "Canada Remote (listed Calgary AB)". Reading
  // those as local would defeat the point: the profile that converted furthest
  // is Edmonton **in-office**, and a remote role based nowhere near him is not
  // that. Hybrid and on-site override it back, since those put him in a room.
  const remote = /\bremote\b|\banywhere\b|\bdistributed\b|\bwork from home\b/.test(s)
  const inRoom = /\bhybrid\b|\bon-?site\b|\bin-?office\b|\bin person\b/.test(s)

  if (edmonton && (inRoom || !remote)) return 'edmonton'
  if (alberta && (inRoom || !remote)) return 'alberta'
  if (remote) return canadian ? 'remote-canada' : 'elsewhere'
  if (canadian) return 'canada'
  return 'elsewhere'
}

export const LOCALITY_LABEL: Record<Locality, string> = {
  edmonton: 'Edmonton',
  alberta: 'Alberta',
  'remote-canada': 'Remote (CA)',
  canada: 'Canada',
  elsewhere: '',
  unknown: '',
}

/** Edmonton and Alberta first — the profile that has converted furthest. */
export const LOCALITY_RANK: Record<Locality, number> = {
  edmonton: 0,
  alberta: 1,
  'remote-canada': 2,
  canada: 3,
  unknown: 4,
  elsewhere: 5,
}

/**
 * Sources that refuse to be read automatically.
 *
 * The add-a-posting form tells the user company and role are optional, because
 * the evaluation worker fills them in from the job description. That is true
 * everywhere except here: Indeed blocks both the Worker and the Mac, so there
 * is no JD, so there is no evaluation, so nothing ever fills them in. A link
 * pasted on its own became a row reading "indeed.com" with an empty role —
 * present, but impossible to recognise in a list of a hundred and fifty.
 *
 * Naming the source rather than returning a boolean so the message can say
 * which one and why.
 */
export function blockedSource(url: string): string | null {
  let host = ''
  try {
    host = new URL(String(url || '').trim()).hostname.toLowerCase()
  } catch {
    return null
  }
  if (/(^|\.)indeed\.(com|ca|co\.uk)$|(^|\.)to\.indeed\.com$/.test(host)) return 'Indeed'
  if (/(^|\.)glassdoor\./.test(host)) return 'Glassdoor'
  if (/(^|\.)ziprecruiter\./.test(host)) return 'ZipRecruiter'
  return null
}

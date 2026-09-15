/**
 * Captures a job description straight from the posting — no model involved.
 *
 * Until 2026-09-15 a JD only reached the site as a side effect of a full
 * career-ops evaluation: the eval worker ran `claude -p`, the report archived
 * the JD under jds/, and `push-postings --upgrade` pushed it. Anything that
 * was not evaluated — unscored postings, anything below the eval worker's
 * --min-score, everything queued while Claude was over its usage limit — never
 * got a JD at all. On that day 72 new postings had none. Reading a job
 * description is an HTTP request, so it no longer waits on an evaluation.
 *
 * One strategy per source, cheapest and most reliable first:
 *
 *   Greenhouse   boards-api JSON              content (entity-encoded HTML)
 *   Lever        postings API JSON            description + lists + additional
 *   Ashby        posting-api job board JSON   descriptionHtml
 *   LinkedIn     the public guest endpoint    show-more-less-html__markup
 *   anything else, the page itself:  JSON-LD JobPosting → schema.org microdata
 *                                     (Job Bank) → a long og:description
 *
 * Indeed blocks automated fetches and Workday renders its description with
 * JavaScript, so those usually fail — with a reason that says so, and the
 * brief offers a box to paste the description instead.
 *
 * Output is light Markdown (## headings, - bullets, **bold**), which the brief
 * renders and the Notion writer turns into blocks.
 */

export class JdCaptureError extends Error {}

export interface JdCapture {
  text: string
  /** Where it came from, shown on the brief: "greenhouse", "linkedin", "page". */
  source: string
}

const MIN_CHARS = 200
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

async function fetchText(url: string, accept = 'text/html,application/xhtml+xml'): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA, Accept: accept, 'Accept-Language': 'en-CA,en;q=0.9' },
    redirect: 'follow',
  })
  return { status: res.status, body: await res.text() }
}

async function fetchJson(url: string): Promise<any> {
  const { status, body } = await fetchText(url, 'application/json')
  if (status !== 200) throw new JdCaptureError(`the API answered ${status}`)
  try {
    return JSON.parse(body)
  } catch {
    throw new JdCaptureError('the API did not return JSON')
  }
}

// ---- HTML → light Markdown ----

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', bull: '•' }
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

export function htmlToMarkdown(input: string): string {
  let s = input
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, t) => `\n\n## ${strip(t)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${strip(t)}`)
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    // A paragraph that is nothing but bold, and short, is a heading in practice
    // ("<p><strong>Responsibilities</strong></p>") — keep it as one so the
    // Notion page gets real sections.
    .replace(/<p[^>]*>\s*<(strong|b)>([^<]{2,80})<\/\1>\s*:?\s*<\/p>/gi, (_, __, t) => `\n\n## ${t.trim().replace(/:$/, '')}\n\n`)
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, (_, __, t) => (strip(t) ? `**${strip(t)}**` : ''))
    .replace(/<\/(p|div|section|article|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  // Postings pasted into an ATS editor often turn one wrapped bullet into two
  // ("Develop the Vue frontend and Python backend software" / "- systems").
  // A bullet that starts lowercase, after one with no closing punctuation, is
  // the rest of the line before it.
  const merged: string[] = []
  for (const line of s.split('\n')) {
    const l = line.replace(/[ \t ]+/g, ' ').trim()
    const prev = merged[merged.length - 1]
    if (prev?.startsWith('- ') && /^- [a-z]/.test(l) && !/[.!?:;)]$/.test(prev)) merged[merged.length - 1] = `${prev} ${l.slice(2)}`
    else merged.push(l)
  }
  return merged
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^(- )\s*$/gm, '')
    .trim()
}

function strip(t: string): string {
  return decodeEntities(t.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** The inner HTML of the first element matching `open`, respecting nesting. */
function innerOf(html: string, open: RegExp, tag: string): string | null {
  const m = open.exec(html)
  if (!m) return null
  const start = m.index + m[0].length
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi')
  re.lastIndex = start
  let depth = 1
  for (let t = re.exec(html); t; t = re.exec(html)) {
    depth += t[1] ? -1 : 1
    if (depth === 0) return html.slice(start, t.index)
  }
  return html.slice(start)
}

// ---- Sources ----

async function greenhouse(u: URL): Promise<JdCapture | null> {
  const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/)
  if (!/greenhouse\.io$/.test(u.hostname) || !m) return null
  const job = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`)
  return { text: htmlToMarkdown(decodeEntities(String(job.content ?? ''))), source: 'greenhouse' }
}

async function lever(u: URL): Promise<JdCapture | null> {
  const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/)
  if (!/^jobs\.(eu\.)?lever\.co$/.test(u.hostname) || !m) return null
  const api = u.hostname.startsWith('jobs.eu.') ? 'api.eu.lever.co' : 'api.lever.co'
  const job = await fetchJson(`https://${api}/v0/postings/${m[1]}/${m[2]}`)
  const parts = [htmlToMarkdown(String(job.description ?? ''))]
  for (const list of job.lists ?? []) parts.push(`## ${strip(String(list.text ?? ''))}\n\n${htmlToMarkdown(`<ul>${list.content ?? ''}</ul>`)}`)
  if (job.additional) parts.push(htmlToMarkdown(String(job.additional)))
  return { text: parts.filter(Boolean).join('\n\n'), source: 'lever' }
}

async function ashby(u: URL): Promise<JdCapture | null> {
  const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/)
  if (u.hostname !== 'jobs.ashbyhq.com' || !m) return null
  const board = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${m[1]}`)
  const job = (board.jobs ?? []).find((j: any) => j.id === m[2] || String(j.jobUrl ?? '').includes(m[2]))
  if (!job) throw new JdCaptureError('the job is no longer on the Ashby board — it may have closed')
  return { text: htmlToMarkdown(String(job.descriptionHtml ?? job.descriptionPlain ?? '')), source: 'ashby' }
}

async function linkedin(u: URL): Promise<JdCapture | null> {
  if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return null
  const id = u.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{6,})/)?.[1] ?? u.searchParams.get('currentJobId')
  if (!id) throw new JdCaptureError('no LinkedIn job id in the link')
  const { status, body } = await fetchText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`)
  if (status === 404) throw new JdCaptureError('LinkedIn says the posting no longer exists')
  if (status !== 200) throw new JdCaptureError(`LinkedIn refused the request (${status})`)
  const inner = innerOf(body, /<div[^>]*class="[^"]*show-more-less-html__markup[^"]*"[^>]*>/i, 'div')
  if (!inner) throw new JdCaptureError('LinkedIn returned a page without the description')
  return { text: htmlToMarkdown(inner), source: 'linkedin' }
}

/** The page itself: structured data first, then the Job Bank microdata, then a long meta description. */
async function page(u: URL): Promise<JdCapture> {
  const { status, body } = await fetchText(u.toString())
  const host = u.hostname.replace(/^www\./, '')
  if (status === 403 || status === 429) {
    const who = /indeed\./.test(host) ? 'Indeed blocks automated fetches' : `${host} refused the request (${status})`
    throw new JdCaptureError(who)
  }
  if (status !== 200) throw new JdCaptureError(`${host} answered ${status}`)

  for (const m of body.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]!.trim())
      const nodes = [data, ...(Array.isArray(data) ? data : []), ...(data?.['@graph'] ?? [])].flat()
      const job = nodes.find((n: any) => n && (n['@type'] === 'JobPosting' || (Array.isArray(n['@type']) && n['@type'].includes('JobPosting'))))
      if (job?.description) return { text: htmlToMarkdown(decodeEntities(String(job.description))), source: 'page' }
    } catch {
      /* one malformed block should not hide a good one further down */
    }
  }

  const micro = /<(\w+)[^>]*\bproperty=["']description["'][^>]*>/i.exec(body)
  if (micro) {
    const inner = innerOf(body, new RegExp(micro[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), micro[1]!)
    if (inner && strip(inner).length >= MIN_CHARS) return { text: htmlToMarkdown(inner), source: 'page' }
  }

  const og = /<meta[^>]+(?:property|name)=["'](?:og:)?description["'][^>]*>/gi
  for (const tag of body.match(og) ?? []) {
    const content = /content=["']([^"']*)["']/i.exec(tag)?.[1]
    if (content && decodeEntities(content).length >= 400) return { text: decodeEntities(content).trim(), source: 'page' }
  }

  if (/myworkday(jobs|site)\.com$/.test(host)) throw new JdCaptureError('Workday loads its descriptions with JavaScript')
  throw new JdCaptureError(`no job description found on ${host}`)
}

export async function captureJD(rawUrl: string): Promise<JdCapture> {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    throw new JdCaptureError('the posting link is not a valid URL')
  }
  let got: JdCapture | null = null
  try {
    got = (await greenhouse(u)) ?? (await lever(u)) ?? (await ashby(u)) ?? (await linkedin(u)) ?? (await page(u))
  } catch (err) {
    if (err instanceof JdCaptureError) throw err
    throw new JdCaptureError(`the fetch failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`)
  }
  const text = got.text.trim()
  if (text.length < MIN_CHARS) throw new JdCaptureError(`${got.source} returned too little text to be a job description`)
  return { ...got, text }
}

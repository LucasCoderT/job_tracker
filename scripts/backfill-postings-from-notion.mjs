/**
 * backfill-postings-from-notion.mjs — give an application a posting, so its
 * tracker row opens a brief instead of leaving the app.
 *
 * The dashboard's board and table link a job to its posting brief, falling back
 * to Notion when the site has no posting for it. On 2026-09-29 that fallback was
 * firing for 95 of 221 applications, and the reason was not a strict matcher:
 * **90 of them had no posting record at all.** They were applied to on the
 * employer's own careers page, which is the channel that actually converts, so
 * the site never heard about them.
 *
 * Reconcile runs posting -> Notion and links what already exists. This runs the
 * other way: Notion -> posting, creating the record from the row's Company,
 * Position and Job Posting URL, then linking it immediately.
 *
 * **Scope is deliberately narrow** (in conversation, or applied in the last 60
 * days). A posting for a job that closed in March is a page with a dead URL and
 * nothing to say, and 90 of them would be noise in the one listing that exists
 * to tell him what to apply to. The rows he actually clicks are the live ones.
 *
 * Two things it cannot do, both by design rather than omission:
 * - **No Job Posting URL, no posting.** A posting's id is sha256(normalizeUrl),
 *   so a row with no URL has no key. Surpass is the standing example; add the
 *   URL to its Notion row and a re-run picks it up.
 * - **A URL another application already owns is refused** (409 from /link), not
 *   stolen. Two Notion rows sharing one job-posting URL means the id is taken by
 *   whichever row claimed it first, and that row is usually the right one.
 *
 * Linking (rather than leaving the posting `new`) is what keeps a historical
 * application out of the apply queue, and `/link` dates it from Notion's own
 * Application Date, never today — these feed the EI week, and stamping today on
 * an application from June would propose an entry he never made.
 *
 *   node scripts/backfill-postings-from-notion.mjs           dry run
 *   node scripts/backfill-postings-from-notion.mjs --apply   create and link
 *
 * Not scheduled. It creates records, and that should stay a decision.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const APPLY = process.argv.includes('--apply')
const RECENT_DAYS = 60
const LIVE = new Set(['pending', 'interviewed', 'progressing', 'offer', 'interviewing', 'on hold'])

const env = Object.fromEntries(
  readFileSync('/Users/lucas/Developer/job_tracker/.env', 'utf8')
    .split('\n').filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
)
const creds = JSON.parse(execFileSync('security',
  ['find-generic-password', '-s', 'dev.codertheory.careerops.site', '-a', 'access-service-token', '-w'],
  { encoding: 'utf8' }).trim())
const H = { 'CF-Access-Client-Id': creds.clientId, 'CF-Access-Client-Secret': creds.clientSecret, 'content-type': 'application/json' }
const site = (p, init = {}) => fetch('https://jobs.codertheory.dev' + p, { redirect: 'manual', headers: H, ...init })

const notion = async (path, body) => {
  const r = await fetch('https://api.notion.com/v1' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new Error(`Notion ${r.status}: ${(await r.text()).slice(0, 160)}`)
  return r.json()
}

// --- every application row
const pages = []
let cursor
do {
  const page = await notion(`/databases/${env.NOTION_DATABASE_ID}/query`, { page_size: 100, start_cursor: cursor })
  pages.push(...page.results)
  cursor = page.has_more ? page.next_cursor : undefined
} while (cursor)

const text = (p, k) => (p.properties?.[k]?.rich_text ?? []).map(t => t.plain_text).join('').trim()
const title = (p) => (p.properties?.Company?.title ?? []).map(t => t.plain_text).join('').trim()
const url = (p) => p.properties?.['Job Posting']?.url ?? null
const status = (p) => (p.properties?.Status?.status?.name ?? p.properties?.Status?.select?.name ?? '').toLowerCase()
const applied = (p) => p.properties?.['Application Date']?.date?.start ?? null

const { postings } = await site('/api/postings').then(r => r.json())
const linked = new Set(postings.filter(p => p.notionPageId).map(p => p.notionPageId))

const ageDays = (d) => (d ? (Date.now() - Date.parse(d)) / 86400000 : Infinity)
const candidates = pages.filter((p) => {
  if (linked.has(p.id)) return false
  const st = status(p)
  const inPlay = LIVE.has(st)
  const recent = ageDays(applied(p)) <= RECENT_DAYS
  return inPlay || recent
})

console.log(`${pages.length} applications in Notion · ${linked.size} already linked`)
console.log(`${candidates.length} in scope (in conversation, or applied in the last ${RECENT_DAYS} days)\n`)

const withUrl = candidates.filter(p => url(p))
const noUrl = candidates.filter(p => !url(p))
for (const p of candidates) {
  const u = url(p)
  console.log(`  ${status(p).padEnd(13)} ${title(p).slice(0, 26).padEnd(27)} ${u ? u.slice(0, 58) : '— NO JOB POSTING URL, cannot create'}`)
}
console.log(`\n${withUrl.length} can be created, ${noUrl.length} have no URL to key a posting on.`)

if (!APPLY) { console.log('\nDry run. Pass --apply to create them.'); process.exit(0) }

let made = 0, failed = 0, skipped = 0
for (const p of withUrl) {
  const body = { url: url(p), company: title(p), role: text(p, 'Position') }
  try {
    const r = await site('/api/postings', { method: 'POST', body: JSON.stringify(body) })
    const j = await r.json()
    if (!r.ok) throw new Error(j.statusMessage || j.message || r.status)
    const id = j.meta.id
    // The posting already belongs to a different application. Two Notion rows
    // sharing one job-posting URL resolve to one id, and the row that claimed
    // it first is usually the right one — so this is a steady state to report,
    // not a failure to retry. Without this a re-run always looks broken.
    if (j.meta.notionPageId && j.meta.notionPageId !== p.id) {
      skipped++
      console.log(`  skip ${title(p).slice(0, 26).padEnd(27)} its URL already belongs to another application`)
      continue
    }
    // Link it straight away: it is applied, and that is what keeps it out of
    // the "what should I apply to" queue and dates it from Notion, not today.
    const lr = await site(`/api/postings/${id}/link`, { method: 'POST', body: JSON.stringify({ notionPageId: p.id }) })
    const lm = await lr.json()
    if (!lr.ok) throw new Error(`created but not linked: ${lm.statusMessage || lr.status}`)
    made++
    console.log(`  ok   ${title(p).slice(0, 26).padEnd(27)} ${id} state=${lm.state}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${title(p).slice(0, 26).padEnd(27)} ${String(err.message).slice(0, 90)}`)
  }
}
console.log(`\n${made} created and linked, ${skipped} skipped, ${failed} failed.`)

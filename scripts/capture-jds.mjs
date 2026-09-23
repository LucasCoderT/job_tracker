#!/usr/bin/env node
/**
 * capture-jds.mjs — fetch the job descriptions Cloudflare cannot reach, from this Mac.
 *
 * The Worker captures a JD the moment a posting arrives (server/utils/jd-capture.ts),
 * and that works for Greenhouse, Lever, Ashby, Workday and Job Bank. LinkedIn
 * answers Cloudflare's addresses with 429 but answers a home connection — and
 * LinkedIn is most of what the scans find. So this runs the very same parser
 * here and sends the result up through PUT /api/postings/:id/jd.
 *
 * Same module, not a copy: it loads the TypeScript through jiti, so a fix to a
 * parser fixes both places.
 *
 * Paced on purpose — one posting every few seconds, a capped number per run —
 * because a burst from one address is exactly what gets a home IP rate
 * limited too. launchd runs it every 30 minutes; a backlog drains over a few
 * runs, and a normal day's new postings go in one.
 *
 *   node scripts/capture-jds.mjs              up to 20 postings
 *   node scripts/capture-jds.mjs --limit=5
 *   node scripts/capture-jds.mjs --dry-run    fetch and report, send nothing
 *
 * Credentials: the Keychain item dev.codertheory.careerops.site
 * ({"clientId","clientSecret"}), or CAREER_OPS_SITE_CLIENT_ID / _SECRET.
 */
import { createJiti } from 'jiti'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const jiti = createJiti(ROOT + '/')
const { captureJD } = await jiti.import('./server/utils/jd-capture.ts')

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const LIMIT = Number((argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] ?? 20) || 20
const PAUSE_MS = 4000
const BASE = (process.env.CAREER_OPS_SITE_BASE || 'https://jobs.codertheory.dev').replace(/\/$/, '')

const log = (msg) => {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)}`
  console.log(`${stamp} [jd-capture] ${msg}`)
}

function credentials() {
  if (process.env.CAREER_OPS_SITE_CLIENT_ID && process.env.CAREER_OPS_SITE_CLIENT_SECRET) {
    return { clientId: process.env.CAREER_OPS_SITE_CLIENT_ID, clientSecret: process.env.CAREER_OPS_SITE_CLIENT_SECRET }
  }
  const raw = execFileSync('security', ['find-generic-password', '-s', 'dev.codertheory.careerops.site', '-a', 'access-service-token', '-w'], { encoding: 'utf8' })
  return JSON.parse(raw.trim())
}
const creds = credentials()

async function site(pathname, method = 'GET', body) {
  const res = await fetch(BASE + pathname, {
    method,
    redirect: 'manual', // an Access bounce is a login page, not data
    headers: {
      'CF-Access-Client-Id': creds.clientId,
      'CF-Access-Client-Secret': creds.clientSecret,
      'Content-Type': 'application/json',
      'User-Agent': 'job-tracker-capture-jds/1',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if ([301, 302, 303, 307, 308, 401, 403].includes(res.status)) throw new Error("the site's Access gate refused the service token")
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} on ${pathname}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { postings = [] } = await site('/api/postings')
// Everything without a JD except what nobody can fetch — Indeed blocks this
// address as well, and asking again every half hour only earns a block.
const todo = postings
  // Read the employer's own req when the resolver found one. An Indeed link is
  // unreadable by anything — fetch, headless Playwright and a direct request are
  // all bounced to bot detection — but the posting it points at is not, and that
  // is what makes an Indeed link usable at all. Only skip when the URL we would
  // actually read is still the unreadable one.
  .filter((p) => !p.hasJD && !/indeed\./i.test(p.employerUrl || p.url))
  .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
if (!todo.length) {
  log('every posting has a JD')
  process.exit(0)
}
log(`${todo.length} without a JD; taking ${Math.min(LIMIT, todo.length)} this run${DRY ? ' (dry run)' : ''}`)

let stored = 0
let limited = false
for (const [i, p] of todo.slice(0, LIMIT).entries()) {
  if (i) await sleep(PAUSE_MS)
  const who = `${p.company} — ${p.role || '?'}`
  try {
    const { text, source } = await captureJD(p.employerUrl || p.url)
    if (DRY) {
      log(`  ✓ ${who}: ${source}, ${text.length} chars (not sent)`)
      continue
    }
    await site(`/api/postings/${p.id}/jd`, 'PUT', { text, source })
    stored++
    log(`  ✓ ${who}: ${source}, ${text.length} chars`)
  } catch (err) {
    log(`  ✗ ${who}: ${err.message}`)
    // Being told to slow down means this address is being watched: stop the
    // run rather than spend the rest of it confirming that.
    if (/\b429\b/.test(err.message)) {
      limited = true
      break
    }
  }
}
log(`${stored} stored${limited ? ' — rate limited, stopping until the next run' : ''}`)

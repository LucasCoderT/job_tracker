#!/usr/bin/env node
/**
 * reconcile-postings.mjs — link postings to the Notion rows they became.
 *
 * The site only learns a posting was applied to when "Mark applied" is pressed
 * on it, and that is not how most applications happen: the ones that convert
 * are sent on the employer's own careers page, where the Notion row gets
 * written and the site never hears about it. 14 of the 107 postings the
 * dashboard called untouched had already been applied to, including every one
 * scoring 4.0 or better — which made the "what should I apply to today" list
 * actively wrong, and made it impossible to measure which recommendations
 * converted.
 *
 * The matching lives in the Worker (server/utils/reconcile.ts), because it
 * needs Notion and the POSTINGS KV together. This is the thing that calls it on
 * a schedule. It is safe to run repeatedly: only ever fills a blank link, never
 * overwrites one, and never creates anything in Notion.
 *
 *   node scripts/reconcile-postings.mjs            link what can be linked
 *   node scripts/reconcile-postings.mjs --dry-run  report, write nothing
 *
 * Credentials: the Keychain item dev.codertheory.careerops.site, as the other
 * producers use.
 */
import { execFileSync } from 'node:child_process'

const DRY = process.argv.slice(2).includes('--dry-run')
const BASE = (process.env.CAREER_OPS_SITE_BASE || 'https://jobs.codertheory.dev').replace(/\/$/, '')

const log = (msg) => {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)}`
  console.log(`${stamp} [reconcile] ${msg}`)
}

function credentials() {
  if (process.env.CAREER_OPS_SITE_CLIENT_ID && process.env.CAREER_OPS_SITE_CLIENT_SECRET) {
    return {
      clientId: process.env.CAREER_OPS_SITE_CLIENT_ID,
      clientSecret: process.env.CAREER_OPS_SITE_CLIENT_SECRET,
    }
  }
  const raw = execFileSync(
    'security',
    ['find-generic-password', '-s', 'dev.codertheory.careerops.site', '-a', 'access-service-token', '-w'],
    { encoding: 'utf8' },
  )
  return JSON.parse(raw.trim())
}

const creds = credentials()

const res = await fetch(`${BASE}/api/postings/reconcile`, {
  method: DRY ? 'GET' : 'POST',
  redirect: 'manual', // an Access bounce is a login page, not data
  headers: {
    'CF-Access-Client-Id': creds.clientId,
    'CF-Access-Client-Secret': creds.clientSecret,
    Accept: 'application/json',
    'User-Agent': 'job-tracker-reconcile/1',
  },
})
if ([301, 302, 303, 307, 308, 401, 403].includes(res.status)) {
  log("the site's Access gate refused the service token")
  process.exit(1)
}
if (!res.ok) {
  log(`${res.status}: ${(await res.text()).slice(0, 200)}`)
  process.exit(1)
}

const report = await res.json()
for (const l of report.links) {
  log(`${DRY ? 'would link' : 'linked'} [${l.matchedOn}] ${l.company} — ${l.role} → ${l.notionStatus ?? 'no status'} ${l.appliedAt?.slice(0, 10) ?? ''}`)
}
// Same company, similar-but-not-identical title. Never written, because this is
// exactly the shape that produces a confident wrong answer.
for (const l of report.probable ?? []) {
  log(`needs a look: ${l.company} — "${l.role}" may be Notion's "${l.notionRole}"`)
}
log(
  `${DRY ? report.links.length + ' linkable' : report.applied + ' linked'} · ${report.alreadyLinked} already linked · ` +
    `${(report.probable ?? []).length} to check · ${report.unmatchedPostings} postings have no Notion row`,
)

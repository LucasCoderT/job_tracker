#!/usr/bin/env node
/**
 * notify-packs.mjs — push a notification when a pack finishes building.
 *
 * A pack takes a median of 41 minutes (fastest 11, slowest 176 across the
 * first ten), so watching the page was never realistic. This tells his phone
 * the moment one lands, through the same ntfy topic career-ops already sends
 * the morning standup to — one feed, nothing new to subscribe to.
 *
 * **Why this runs on the Mac and not in the Worker.** Sending it from the
 * route that marks a pack done would be the obvious design, and it was tried:
 * ntfy.sh answered the Worker with `429 daily message quota reached` while the
 * identical publish from this Mac returned 200. ntfy identifies a "visitor" by
 * IP address, and authenticating does not change that — so a Worker shares one
 * quota with every other Cloudflare customer's egress, and it is always spent.
 * Only a paid plan (account-based) or a self-hosted server would fix it. The
 * Mac has its own address and already publishes fine, so the Mac sends.
 *
 * It polls rather than listens, because the alternative is holding a WebSocket
 * open from a launchd job. Two GETs every two minutes against a 41-minute
 * build is not a latency problem.
 *
 *   node scripts/notify-packs.mjs             notify anything newly finished
 *   node scripts/notify-packs.mjs --dry-run   print what it would send
 *   node scripts/notify-packs.mjs --reset     re-seed state, send nothing
 *
 * Credentials: the Keychain item dev.codertheory.careerops.site, as the other
 * producers use. Topic: career-ops/local/ntfy-topic, or $NTFY_TOPIC.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const RESET = argv.includes('--reset')
const BASE = (process.env.CAREER_OPS_SITE_BASE || 'https://jobs.codertheory.dev').replace(/\/$/, '')
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '')
const TOPIC_FILE = process.env.NTFY_TOPIC_FILE || path.join(homedir(), 'Developer/career-ops/local/ntfy-topic')
const STATE_DIR = path.join(homedir(), 'Library/Application Support/job-tracker')
const STATE_FILE = path.join(STATE_DIR, 'notified-packs.json')

const log = (msg) => {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)}`
  console.log(`${stamp} [pack-notify] ${msg}`)
}

function topic() {
  if (process.env.NTFY_TOPIC) return process.env.NTFY_TOPIC.trim()
  try {
    return readFileSync(TOPIC_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

function credentials() {
  if (process.env.CAREER_OPS_SITE_CLIENT_ID && process.env.CAREER_OPS_SITE_CLIENT_SECRET) {
    return { clientId: process.env.CAREER_OPS_SITE_CLIENT_ID, clientSecret: process.env.CAREER_OPS_SITE_CLIENT_SECRET }
  }
  const raw = execFileSync(
    'security',
    ['find-generic-password', '-s', 'dev.codertheory.careerops.site', '-a', 'access-service-token', '-w'],
    { encoding: 'utf8' },
  )
  return JSON.parse(raw.trim())
}
const creds = credentials()

async function site(pathname) {
  const res = await fetch(BASE + pathname, {
    redirect: 'manual', // an Access bounce is a login page, not data
    headers: {
      'CF-Access-Client-Id': creds.clientId,
      'CF-Access-Client-Secret': creds.clientSecret,
      Accept: 'application/json',
      'User-Agent': 'job-tracker-pack-notify/1',
    },
  })
  if ([301, 302, 303, 307, 308, 401, 403].includes(res.status)) throw new Error("the site's Access gate refused the service token")
  if (!res.ok) throw new Error(`${res.status} on ${pathname}`)
  return await res.json()
}

async function push({ title, message, tags, click }) {
  const t = topic()
  if (!t) throw new Error(`no ntfy topic (${TOPIC_FILE} missing and $NTFY_TOPIC unset)`)
  const res = await fetch(`${NTFY_SERVER}/${encodeURIComponent(t)}`, {
    method: 'POST',
    headers: {
      // HTTP header values are not UTF-8: a "·" in the title arrives as a
      // replacement character on the phone. The body is sent as the request
      // body and keeps its accents; only the title has to be plain ASCII.
      Title: title.replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120),
      Tags: tags.join(','),
      Click: click,
      'User-Agent': 'job-tracker-pack-notify/1',
    },
    body: message.slice(0, 3000),
  })
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${(await res.text()).slice(0, 140)}`)
}

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}
const writeState = (state) => {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

// Keyed by the build that produced it, so a rebuild of a pack he has already
// been told about notifies again, and a status that has not moved does not.
const stampOf = (status, at) => `${status}@${at ?? ''}`

const [postings, packs] = await Promise.all([site('/api/postings'), site('/api/packs')])

const current = {}
const pending = []
for (const p of postings.postings ?? []) {
  const key = `apply:${p.id}`
  if (p.pack !== 'done' && p.pack !== 'failed') continue
  current[key] = stampOf(p.pack, p.packBuiltAt || p.updatedAt)
  const who = `${p.company}${p.role ? ` — ${p.role}` : ''}`
  pending.push({
    key,
    note:
      p.pack === 'done'
        ? {
            title: `Pack ready: ${p.company}`,
            message: `${who}\n${p.artifacts.length} file${p.artifacts.length === 1 ? '' : 's'} ready to download and send.`,
            tags: ['briefcase'],
            click: `${BASE}/postings/${p.id}?from=/`,
          }
        : {
            title: `Pack failed: ${p.company}`,
            message: `${who}\n${p.packError || 'The Mac could not build it.'}`,
            tags: ['warning'],
            click: `${BASE}/postings/${p.id}?from=/`,
          },
  })
}
for (const p of packs.packs ?? []) {
  const key = `interview:${p.jobId}`
  if (p.status !== 'done' && p.status !== 'failed') continue
  current[key] = stampOf(p.status, p.builtAt || p.updatedAt)
  const who = `${p.company}${p.position ? ` — ${p.position}` : ''}`
  pending.push({
    key,
    note:
      p.status === 'done'
        ? {
            title: `Interview pack ready: ${p.company}`,
            message: `${who}\n${p.answers} card${p.answers === 1 ? '' : 's'} ready to read.`,
            tags: ['book'],
            click: `${BASE}/packs/${p.jobId}?from=/`,
          }
        : {
            title: `Interview pack failed: ${p.company}`,
            message: `${who}\n${p.error || 'The Mac could not build it.'}`,
            tags: ['warning'],
            click: `${BASE}/packs/${p.jobId}?from=/`,
          },
  })
}

const previous = readState()
// First run — or --reset — records where things stand and says nothing. Without
// this, installing it would announce every pack ever built, all at once.
if (previous === null || RESET) {
  writeState(current)
  log(`${Object.keys(current).length} finished pack(s) recorded as already seen — nothing sent`)
  process.exit(0)
}

const fresh = pending.filter((p) => previous[p.key] !== current[p.key])
if (!fresh.length) {
  log('nothing new')
  process.exit(0)
}

let sent = 0
for (const f of fresh) {
  if (DRY) {
    log(`would send: ${f.note.title} — ${f.note.message.split('\n').join(' / ')}`)
    continue
  }
  try {
    await push(f.note)
    sent++
    log(`sent: ${f.note.title}`)
  } catch (err) {
    log(`FAILED: ${f.note.title}: ${err.message}`)
    // Leave it out of the saved state so the next run tries again.
    delete current[f.key]
    if (previous[f.key]) current[f.key] = previous[f.key]
  }
}
if (!DRY) writeState(current)
log(`${sent} notification${sent === 1 ? '' : 's'} sent`)

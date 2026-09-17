#!/usr/bin/env node
/**
 * notify-agent-work.mjs — tell his phone when something he handed to an agent finishes.
 *
 * Anything requested on the site and built on the Mac is a wait: a CV pack takes
 * a median of 41 minutes, an interview pack longer, and drafted answers are
 * drained on the apply worker's 20-minute tick. Watching the page was never
 * realistic, so this pushes to the ntfy topic career-ops already sends the
 * morning standup to — one feed, nothing new to subscribe to.
 *
 * This started as a pack-only notifier and immediately had the gap you would
 * expect: he submitted application questions for drafting and had no idea when
 * they landed. So the watchers are a **list**, not three code paths. Everything
 * the site can hand to an agent belongs in WATCHERS, and adding the next one is
 * one entry rather than another script.
 *
 * **Why this runs on the Mac and not in the Worker.** Sending from the route
 * that marks work done is the obvious design and was tried: ntfy.sh answered the
 * Worker with `429 daily message quota reached` while the identical publish from
 * this Mac returned 200. ntfy identifies a "visitor" by IP address and
 * authenticating does not change that, so a Worker shares one quota with every
 * other Cloudflare customer's egress and it is permanently spent. Only a paid
 * plan or self-hosting would fix it.
 *
 *   node scripts/notify-agent-work.mjs             notify anything newly finished
 *   node scripts/notify-agent-work.mjs --dry-run   print what it would send
 *   node scripts/notify-agent-work.mjs --reset     re-seed state, send nothing
 *
 * Credentials: the Keychain item dev.codertheory.careerops.site, as the other
 * producers use. Topic: career-ops/local/ntfy-topic, or $NTFY_TOPIC.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const RESET = argv.includes('--reset')
const BASE = (process.env.CAREER_OPS_SITE_BASE || 'https://jobs.codertheory.dev').replace(/\/$/, '')
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '')
const TOPIC_FILE = process.env.NTFY_TOPIC_FILE || path.join(homedir(), 'Developer/career-ops/local/ntfy-topic')
const STATE_DIR = path.join(homedir(), 'Library/Application Support/job-tracker')
// Kept from the pack-only version on purpose: apply: and interview: history
// carries over, so renaming the script does not re-announce every finished pack.
const STATE_FILE = path.join(STATE_DIR, 'notified-packs.json')

const log = (msg) => {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)}`
  console.log(`${stamp} [agent-notify] ${msg}`)
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

async function site(pathname) {
  const res = await fetch(BASE + pathname, {
    redirect: 'manual', // an Access bounce is a login page, not data
    headers: {
      'CF-Access-Client-Id': creds.clientId,
      'CF-Access-Client-Secret': creds.clientSecret,
      Accept: 'application/json',
      'User-Agent': 'job-tracker-agent-notify/1',
    },
  })
  if ([301, 302, 303, 307, 308, 401, 403].includes(res.status)) {
    throw new Error("the site's Access gate refused the service token")
  }
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
      'User-Agent': 'job-tracker-agent-notify/1',
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

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * Everything the site can hand to an agent.
 *
 * `rows` pulls the records, `finished` decides which are done with waiting,
 * `stamp` is what makes a *re-run* of the same work count as new — keyed by the
 * build that produced it, so rebuilding notifies again and a status that has
 * not moved stays quiet.
 */
const WATCHERS = [
  {
    ns: 'apply',
    label: 'apply pack',
    rows: async () => (await site('/api/postings')).postings ?? [],
    id: (p) => p.id,
    finished: (p) => p.pack === 'done' || p.pack === 'failed',
    stamp: (p) => `${p.pack}@${p.packBuiltAt || p.updatedAt || ''}`,
    ok: (p) => p.pack === 'done',
    note: (p) => ({
      title: `Pack ready: ${p.company}`,
      message: `${p.company}${p.role ? ` — ${p.role}` : ''}\n${plural(p.artifacts.length, 'file')} ready to download and send.`,
      tags: ['briefcase'],
      click: `${BASE}/postings/${p.id}?from=/`,
    }),
    failure: (p) => ({
      title: `Pack failed: ${p.company}`,
      message: `${p.company}${p.role ? ` — ${p.role}` : ''}\n${p.packError || 'The Mac could not build it.'}`,
      tags: ['warning'],
      click: `${BASE}/postings/${p.id}?from=/`,
    }),
  },
  {
    // The gap that prompted this rewrite: he submitted questions for drafting
    // and nothing told him when the answers landed.
    ns: 'questions',
    label: 'drafted answers',
    rows: async () => (await site('/api/postings')).postings ?? [],
    id: (p) => p.id,
    finished: (p) => p.answerStatus === 'done' || p.answerStatus === 'failed',
    // The meta carries no build time for answers, so the answered count is what
    // moves. A redraft passes through `requested`, which drops the key out of
    // the watched set entirely and makes its return count as new — so a redraft
    // notifies even when it lands on the same number.
    stamp: (p) => `${p.answerStatus}@${p.answered}/${p.questions}`,
    ok: (p) => p.answerStatus === 'done',
    note: (p) => ({
      title: `Answers drafted: ${p.company}`,
      message: `${p.company}${p.role ? ` — ${p.role}` : ''}\n${p.answered} of ${plural(p.questions, 'question')} answered, ready to read and edit.`,
      tags: ['pencil'],
      click: `${BASE}/postings/${p.id}/questions?from=/`,
    }),
    failure: (p) => ({
      title: `Answers failed: ${p.company}`,
      message: `${p.company}${p.role ? ` — ${p.role}` : ''}\nThe Mac could not draft them.`,
      tags: ['warning'],
      click: `${BASE}/postings/${p.id}/questions?from=/`,
    }),
  },
  {
    ns: 'interview',
    label: 'interview pack',
    rows: async () => (await site('/api/packs')).packs ?? [],
    id: (p) => p.jobId,
    finished: (p) => p.status === 'done' || p.status === 'failed',
    stamp: (p) => `${p.status}@${p.builtAt || p.updatedAt || ''}`,
    ok: (p) => p.status === 'done',
    note: (p) => ({
      title: `Interview pack ready: ${p.company}`,
      message: `${p.company}${p.position ? ` — ${p.position}` : ''}\n${plural(p.answers, 'card')} ready to read.`,
      tags: ['book'],
      click: `${BASE}/packs/${p.jobId}?from=/`,
    }),
    failure: (p) => ({
      title: `Interview pack failed: ${p.company}`,
      message: `${p.company}${p.position ? ` — ${p.position}` : ''}\n${p.error || 'The Mac could not build it.'}`,
      tags: ['warning'],
      click: `${BASE}/packs/${p.jobId}?from=/`,
    }),
  },
]

const current = {}
const pending = []
for (const w of WATCHERS) {
  for (const row of await w.rows()) {
    if (!w.finished(row)) continue
    const key = `${w.ns}:${w.id(row)}`
    current[key] = w.stamp(row)
    pending.push({ key, ns: w.ns, note: w.ok(row) ? w.note(row) : w.failure(row) })
  }
}

const previous = readState()
// First run — or --reset — records where things stand and says nothing. Without
// this, installing it would announce every pack ever built, all at once.
if (previous === null || RESET) {
  if (DRY) {
    log(`would record ${Object.keys(current).length} finished item(s) and send nothing`)
    process.exit(0)
  }
  writeState(current)
  log(`${Object.keys(current).length} finished item(s) recorded as already seen — nothing sent`)
  process.exit(0)
}

/**
 * A watcher added after the state file was written has no history, and every
 * already-finished item under it would look new. Seed that namespace silently
 * instead — the same courtesy the first run gets, per watcher rather than once
 * for the whole script. This is what let "questions" be added without
 * announcing every set of answers drafted to date.
 */
const knownNamespaces = new Set(Object.keys(previous).map((k) => k.split(':')[0]))
const unseeded = WATCHERS.filter((w) => !knownNamespaces.has(w.ns)).map((w) => w.ns)
for (const ns of unseeded) log(`first run for ${ns} — recording what is already finished, sending nothing`)

const fresh = pending.filter((p) => !unseeded.includes(p.ns) && previous[p.key] !== current[p.key])
if (!fresh.length) {
  if (unseeded.length && !DRY) writeState({ ...previous, ...current })
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

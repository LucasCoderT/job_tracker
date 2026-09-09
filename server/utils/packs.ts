/**
 * Interview packs: storage in the PACKS KV namespace, the bank lint, the
 * Notion beat-line format, and the printable prep sheet.
 *
 * One pack per application row, keyed by its Notion page id:
 *   meta:<jobId>            PackMeta (status, counts, exports index)
 *   bank:<jobId>            AnswerBank — the JSON InterviewHelper imports
 *   export:<jobId>:<name>   text exports the desktop worker publishes
 *
 * The lint and the beat-line format live in shared/bank.ts (the editor
 * in the browser uses them too).
 * Nothing here writes answers — the site stores and edits his words, the
 * Mac builds the bank, and neither invents content.
 */
import type { Answer, AnswerBank, PackExport, PackMeta, PackStatus } from '../../shared/types'
import type { AppEnv, KVNamespace } from './notion'
import { slugify } from '../../shared/bank'

export { slugify, cleanAnswer, cleanBank, parseBeats, beatsToLines, lint } from '../../shared/bank'

export const STATUSES: PackStatus[] = ['requested', 'building', 'done', 'failed']

const metaKey = (jobId: string) => `meta:${jobId}`
const bankKey = (jobId: string) => `bank:${jobId}`
const exportKey = (jobId: string, name: string) => `export:${jobId}:${name}`

export function packsKV(env: AppEnv): KVNamespace | null {
  return env.PACKS ?? null
}

// Notion page ids arrive with or without dashes; a pack must not split in two.
export function normalizeJobId(raw: string): string {
  const s = String(raw || '').trim().toLowerCase()
  const hex = s.replace(/-/g, '')
  if (/^[0-9a-f]{32}$/.test(hex)) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return s.replace(/[^a-z0-9._:-]/g, '')
}

export function safeExportName(name: string): string {
  return String(name || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 80)
}

// ---- KV ----

export async function listPacks(kv: KVNamespace): Promise<PackMeta[]> {
  const metas: PackMeta[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix: 'meta:', limit: 1000, cursor })
    const got = await Promise.all(page.keys.map((k) => kv.get(k.name, 'json')))
    for (const m of got) if (m) metas.push(m as PackMeta)
    cursor = page.list_complete === false ? page.cursor : undefined
  } while (cursor)
  metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return metas
}

export async function getMeta(kv: KVNamespace, jobId: string): Promise<PackMeta | null> {
  return ((await kv.get(metaKey(jobId), 'json')) as PackMeta | null) ?? null
}

export async function putMeta(kv: KVNamespace, meta: PackMeta): Promise<void> {
  await kv.put(metaKey(meta.jobId), JSON.stringify(meta))
}

export async function getBank(kv: KVNamespace, jobId: string): Promise<AnswerBank | null> {
  const bank = (await kv.get(bankKey(jobId), 'json')) as AnswerBank | null
  return bank && Array.isArray(bank.answers) ? bank : null
}

export async function putBank(kv: KVNamespace, jobId: string, bank: AnswerBank): Promise<void> {
  await kv.put(bankKey(jobId), JSON.stringify(bank))
}

export async function getExport(
  kv: KVNamespace,
  jobId: string,
  name: string,
): Promise<{ body: string; contentType: string } | null> {
  const meta = await getMeta(kv, jobId)
  const entry = meta?.exports.find((e) => e.name === name)
  if (!entry) return null
  const body = (await kv.get(exportKey(jobId, name), 'text')) as string | null
  return body === null ? null : { body, contentType: entry.contentType }
}

export async function putExport(
  kv: KVNamespace,
  meta: PackMeta,
  name: string,
  body: string,
  contentType: string,
): Promise<PackMeta> {
  await kv.put(exportKey(meta.jobId, name), body)
  const entry: PackExport = {
    name,
    contentType,
    bytes: new TextEncoder().encode(body).length,
    updatedAt: new Date().toISOString(),
  }
  const exports = meta.exports.filter((e) => e.name !== name).concat(entry)
  exports.sort((a, b) => a.name.localeCompare(b.name))
  const next = { ...meta, exports, updatedAt: entry.updatedAt }
  await putMeta(kv, next)
  return next
}

export async function deleteExport(kv: KVNamespace, meta: PackMeta, name: string): Promise<PackMeta> {
  await kv.delete(exportKey(meta.jobId, name))
  const next = { ...meta, exports: meta.exports.filter((e) => e.name !== name), updatedAt: new Date().toISOString() }
  await putMeta(kv, next)
  return next
}

export async function deletePack(kv: KVNamespace, meta: PackMeta): Promise<void> {
  await Promise.all(meta.exports.map((e) => kv.delete(exportKey(meta.jobId, e.name))))
  await kv.delete(bankKey(meta.jobId))
  await kv.delete(metaKey(meta.jobId))
}

/** Recount answers/beats from a bank onto the meta (does not save). */
export function withCounts(meta: PackMeta, bank: AnswerBank | null): PackMeta {
  const answers = bank?.answers ?? []
  return {
    ...meta,
    answers: answers.length,
    beats: answers.reduce((n, a) => n + (a.beats?.length ?? 0), 0),
  }
}

// ---- Prep sheet (port of Core/PrepSheet.swift) ----

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function card(answer: Answer, lead: string | null): string {
  let out = `<div class=card><h3>${esc(answer.question)}</h3>`
  const meta: string[] = []
  if (lead) meta.push(`<span class=num>${esc(lead)}</span>`)
  if (answer.minSeconds) meta.push(`floor ${clock(answer.minSeconds)}`)
  if (meta.length) out += `<p class=meta>${meta.join(' · ')}</p>`
  for (const beat of answer.beats) {
    const stance = beat.stance ? ` <span class=stance>${esc(beat.stance)}</span>` : ''
    out += `<div class=beat><span class=dot></span><span class=text>${esc(beat.text)}${stance}</span></div>`
  }
  const script = (answer.script ?? '').trim()
  if (script) out += `<p class=script>${esc(script)}</p>`
  if (answer.avoid?.length) out += `<p class=avoid>never say: ${answer.avoid.map(esc).join(' · ')}</p>`
  return out + '</div>'
}

/** Same Broadsheet ink as the app's prep sheet: works on a phone, prints. */
export function prepSheetHTML(bank: AnswerBank, meta: PackMeta): string {
  const title = bank.title || `${meta.company} — ${meta.position}`.trim()
  const deckIDs = (bank.presentation ?? []).map((s) => s.answerId)
  const others = bank.answers.filter((a) => !deckIDs.includes(a.id))
  const stamp = new Date().toLocaleString('en-CA', { timeZone: 'America/Edmonton', dateStyle: 'full', timeStyle: 'short' })

  let html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — prep sheet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap" rel="stylesheet">
<style>
:root{--bg:#f3f2f2;--ink:#201e1d;--divider:rgba(32,30,29,.16);--row:rgba(32,30,29,.08);
  --n500:#9b9797;--n600:#7d7979;--n700:#605d5d;
  --cyan:#0088b0;--cyan100:#e9f8ff;--cyan800:#004961;
  --magenta:#d6006c;--magenta100:#fff1f4;--magenta700:#aa0b56}
@media (prefers-color-scheme: dark){:root{--bg:#201e1d;--ink:#f3f2f2;--divider:rgba(243,242,242,.15);--row:rgba(243,242,242,.08);
  --n500:#7d7979;--n600:#9b9797;--n700:#bab6b6;
  --cyan:#62c5ee;--cyan100:#0a303e;--cyan800:#99e0ff;
  --magenta:#ff458e;--magenta100:#4b1528;--magenta700:#ff90b1}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "Source Serif 4",Georgia,"Times New Roman",serif}
main{max-width:760px;padding:32px 22px 72px;margin:0 auto}
@media (min-width:700px){main{padding:44px 44px 72px}}
h1{font-size:30px;font-weight:600;line-height:1.12;letter-spacing:-.015em;margin:4px 0 6px}
.kicker{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--cyan);margin:40px 0 10px}
.kicker.first{margin-top:0}
.dateline{color:var(--n700);font-size:13px;margin:0 0 14px}
.rule{height:3px;background:var(--ink)}.rule.thin{height:1px;margin-top:2px}
.card{margin:22px 0 30px;break-inside:avoid}
.card h3{font-size:18px;font-weight:600;line-height:1.25;letter-spacing:-.01em;margin:0 0 2px}
.meta{color:var(--n600);font-size:12px;margin:0 0 10px}
.num{font-variant-numeric:tabular-nums}
.beat{display:flex;gap:11px;align-items:baseline;padding:3px 0}
.beat .dot{width:8px;height:8px;border-radius:50%;background:var(--magenta);flex:none;position:relative;top:-1px}
.beat .text{font-weight:600;font-size:16px;letter-spacing:-.01em}
.beat .stance{color:var(--n600);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.script{white-space:pre-wrap;color:var(--n700);font-size:14px;margin:10px 0 0;padding-left:19px;border-left:1px solid var(--divider)}
.avoid{color:var(--magenta700);font-size:13px;margin:8px 0 0;padding-left:19px}
.toc{columns:2;column-gap:28px;font-size:13px;color:var(--n700);margin:0}
.toc div{padding:2px 0;break-inside:avoid}
@media print{body{background:#fff;color:#000}main{max-width:none;padding:0 0 12pt}
  .kicker{margin-top:18pt}.card{margin:10pt 0 14pt}a{color:inherit}}
</style></head><body><main>
<div class="kicker first">Prep sheet — everything the Nook would show</div>
<h1>${esc(title)}</h1>
<div class="dateline">${bank.answers.length} answers · ${esc(stamp)} · no app required</div>
<div class="rule"></div><div class="rule thin"></div>
`

  const sections = bank.presentation ?? []
  if (sections.length) {
    const total = sections.reduce((n, s) => n + s.budgetSeconds, 0)
    html += `<div class=kicker>The deck — ${sections.length} sections, ${Math.floor(total / 60)} minutes</div>`
    sections.forEach((section, index) => {
      const answer = bank.answers.find((a) => a.id === section.answerId)
      if (answer) html += card(answer, `${index + 1} · ${clock(section.budgetSeconds)}`)
    })
  }
  if (others.length) {
    html += `<div class=kicker>Everything else — ${others.length} answers</div>`
    html += `<div class=toc>${others.map((a) => `<div>${esc(a.question)}</div>`).join('')}</div>`
    for (const answer of others) html += card(answer, null)
  }
  if (bank.avoid?.length) {
    html += `<div class=kicker>Never say</div><div class=avoid>${bank.avoid.map(esc).join(' · ')}</div>`
  }
  return html + '</main></body></html>'
}

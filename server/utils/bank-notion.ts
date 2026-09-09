/**
 * Write-back to the 🎤 Interview Answer Bank database.
 *
 * The site is where he edits a pack from his phone; Notion is where the
 * writing is kept. So every card edit on the web lands in both: the KV bank
 * (what the app imports, at once) and the Notion row (the record, and what
 * the next "regenerate" is built from — which is how an edit survives a
 * rebuild). Same column mapping as Scripts/sync_bank.py in InterviewHelper:
 *
 *   Question (title) · Cues · Beats (`text [STANCE] :: keys` lines) · Script
 *   · Avoid · Floor (number) · Active (checkbox) · Answer ID · Companies
 *   (relation → DB Applications; empty = universal, tagged = that company)
 *
 * A row is found by Answer ID, then by exact Question; a card with no row
 * gets one, tagged to this application. A universal row is edited in place
 * (the edit applies to every bank — the caller is told) but is never
 * deactivated from a single pack's page.
 */
import type { Answer, NotionWriteResult } from '../../shared/types'
import type { AppEnv } from './notion'
import { NOTION_VERSION, DEFAULT_BANK_DATABASE_ID } from './config'
import { beatsToLines } from '../../shared/bank'

function bankEnv(env: AppEnv): { token: string; db: string } | null {
  const token = env.NOTION_BANK_TOKEN || env.NOTION_TOKEN
  if (!token) return null
  return { token, db: env.NOTION_BANK_DATABASE_ID || DEFAULT_BANK_DATABASE_ID }
}

async function notion(token: string, path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data?.message || `${res.status}`
    if (res.status === 404) {
      throw new Error(
        `Notion cannot see the answer bank (404). Share the 🎤 Interview Answer Bank database with the dashboard's integration (••• → Connections), or set NOTION_BANK_TOKEN.`,
      )
    }
    throw new Error(`Notion ${res.status}: ${String(msg).slice(0, 200)}`)
  }
  return data
}

// Notion caps one rich_text element at 2000 characters; scripts run longer.
function richText(text: string) {
  const chunks: { text: { content: string } }[] = []
  for (let i = 0; i < text.length; i += 2000) chunks.push({ text: { content: text.slice(i, i + 2000) } })
  return { rich_text: chunks }
}

function properties(answer: Answer) {
  return {
    Question: { title: [{ text: { content: answer.question } }] },
    Cues: richText(answer.cues.join(', ')),
    Beats: richText(beatsToLines(answer.beats)),
    Script: richText(answer.script ?? ''),
    Avoid: richText((answer.avoid ?? []).join(', ')),
    Floor: { number: answer.minSeconds ?? null },
    'Answer ID': richText(answer.id),
    Active: { checkbox: true },
  }
}

function relationIds(page: any): string[] {
  const rel = page?.properties?.Companies?.relation
  return Array.isArray(rel) ? rel.map((r: any) => String(r.id).replace(/-/g, '')) : []
}

export interface FoundPage {
  id: string
  url: string | null
  companies: string[] // page ids without dashes
}

export async function findAnswerPage(env: AppEnv, answer: Answer): Promise<FoundPage | null> {
  const cfg = bankEnv(env)
  if (!cfg) return null
  const filters = [
    { property: 'Answer ID', rich_text: { equals: answer.id } },
    { property: 'Question', title: { equals: answer.question } },
  ]
  for (const filter of filters) {
    const data = await notion(cfg.token, `/databases/${cfg.db}/query`, 'POST', { filter, page_size: 1 })
    const page = data?.results?.[0]
    if (page) return { id: page.id, url: page.url ?? null, companies: relationIds(page) }
  }
  return null
}

/** Upsert one card into Notion. Never throws; the caller shows the result. */
export async function writeAnswer(env: AppEnv, jobId: string, answer: Answer): Promise<NotionWriteResult> {
  const cfg = bankEnv(env)
  if (!cfg) return { ok: false, error: 'No Notion token configured.' }
  try {
    const existing = await findAnswerPage(env, answer)
    const job = jobId.replace(/-/g, '')
    if (existing) {
      const page = await notion(cfg.token, `/pages/${existing.id}`, 'PATCH', { properties: properties(answer) })
      const scope = existing.companies.length ? 'company' : 'universal'
      return { ok: true, pageId: page.id, url: page.url ?? existing.url, created: false, scope }
    }
    const page = await notion(cfg.token, '/pages', 'POST', {
      parent: { database_id: cfg.db },
      properties: { ...properties(answer), Companies: { relation: [{ id: job }] } },
    })
    return { ok: true, pageId: page.id, url: page.url ?? null, created: true, scope: 'company' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/**
 * A card removed from a pack: its Notion row is unticked (Active), not
 * deleted — record keeping — and only when the row belongs to this
 * application. A universal row stays as it is.
 */
export async function retireAnswer(env: AppEnv, jobId: string, answer: Answer): Promise<NotionWriteResult> {
  const cfg = bankEnv(env)
  if (!cfg) return { ok: false, error: 'No Notion token configured.' }
  try {
    const existing = await findAnswerPage(env, answer)
    if (!existing) return { ok: false, error: 'No matching row in Notion.' }
    const job = jobId.replace(/-/g, '')
    if (!existing.companies.includes(job)) {
      return { ok: true, pageId: existing.id, url: existing.url, created: false, scope: 'universal' }
    }
    await notion(cfg.token, `/pages/${existing.id}`, 'PATCH', { properties: { Active: { checkbox: false } } })
    return { ok: true, pageId: existing.id, url: existing.url, created: false, scope: 'company' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

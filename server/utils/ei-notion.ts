/**
 * The EI Job Search Activity Log — read for a week, and append confirmed rows.
 *
 * This is his record for Service Canada, and he has already sat one audit
 * interview on it, so two rules shape everything here:
 *
 * 1. **`Time Spent` is never written by software.** It is a declaration about
 *    his own hours. The route refuses a row without it rather than defaulting
 *    to something plausible — a guessed number is exactly what an auditor
 *    pulls on, and it would be his signature on it, not ours.
 * 2. **Dates are America/Edmonton**, not UTC. He applies in the evening; in
 *    UTC that is the next day, which would file a whole evening under a day
 *    he can't account for.
 *
 * Same shape as bank-notion.ts: a private fetch wrapper, a 404 that says what
 * to go and click, and errors that are returned rather than thrown at the UI.
 */
import type { EiEntryInput, EiLogged, EiWriteResult } from '../../shared/types'
import type { AppEnv } from './notion'
import { NOTION_VERSION, DEFAULT_EI_DATABASE_ID } from './config'

function eiEnv(env: AppEnv): { token: string; db: string } | null {
  const token = env.NOTION_EI_TOKEN || env.NOTION_TOKEN
  if (!token) return null
  return { token, db: env.NOTION_EI_DATABASE_ID || DEFAULT_EI_DATABASE_ID }
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
    if (res.status === 404) {
      throw new Error(
        'Notion cannot see the EI Job Search Activity Log (404). Share that database with the dashboard’s integration (••• → Connections), or set NOTION_EI_TOKEN.',
      )
    }
    throw new Error(`Notion ${res.status}: ${String(data?.message || res.status).slice(0, 200)}`)
  }
  return data
}

const plain = (prop: any): string =>
  (prop?.title ?? prop?.rich_text ?? []).map((t: any) => t?.plain_text ?? '').join('').trim()

/** Rows already logged for the week — the dedupe source and the "done" list. */
export async function readWeek(env: AppEnv, monday: string, sunday: string): Promise<EiLogged[]> {
  const cfg = eiEnv(env)
  if (!cfg) throw new Error('No Notion token on this deploy.')
  const out: EiLogged[] = []
  let cursor: string | undefined
  do {
    const page: any = await notion(cfg.token, `/databases/${cfg.db}/query`, 'POST', {
      filter: {
        and: [
          { property: 'Date', date: { on_or_after: monday } },
          { property: 'Date', date: { on_or_before: sunday } },
        ],
      },
      sorts: [{ property: 'Date', direction: 'ascending' }],
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    })
    for (const row of page.results ?? []) {
      const p = row.properties ?? {}
      out.push({
        date: p.Date?.date?.start?.slice(0, 10) ?? '',
        method: p.Method?.select?.name ?? '',
        activity: plain(p.Activity),
        timeSpent: p['Time Spent']?.select?.name ?? null,
      })
    }
    cursor = page.has_more ? page.next_cursor : undefined
  } while (cursor)
  return out
}

/**
 * Appends the rows he confirmed. One page per row, sequentially: a dozen rows
 * a week is not worth a concurrency story, and if one fails the rest still
 * land and the failure is named.
 */
export async function writeEntries(env: AppEnv, entries: EiEntryInput[]): Promise<EiWriteResult> {
  const cfg = eiEnv(env)
  if (!cfg) return { written: 0, failed: entries.map((e) => ({ activity: e.activity, error: 'No Notion token.' })) }

  const result: EiWriteResult = { written: 0, failed: [] }
  for (const e of entries) {
    try {
      await notion(cfg.token, '/pages', 'POST', {
        parent: { database_id: cfg.db },
        properties: {
          Activity: { title: [{ text: { content: e.activity.slice(0, 1900) } }] },
          Date: { date: { start: e.date } },
          Method: { select: { name: e.method } },
          Outcome: { select: { name: e.outcome } },
          'Time Spent': { select: { name: e.timeSpent } },
          ...(e.notes ? { Notes: { rich_text: [{ text: { content: e.notes.slice(0, 1900) } }] } } : {}),
        },
      })
      result.written++
    } catch (err: any) {
      result.failed.push({ activity: e.activity, error: String(err?.message || err).slice(0, 300) })
    }
  }
  return result
}

/**
 * Creating a row in "DB Applications" — the one write the dashboard makes to
 * the database it otherwise only reads.
 *
 * When he presses "Mark applied" on a posting, the application has to exist
 * in Notion or it never reaches the funnel: Notion is still the source of
 * truth and the data-entry surface, and this just saves him retyping what
 * career-ops already knows. Nothing else here writes applications.
 *
 *   Company (title) · Position · Status → "Applied" · Application Date
 *   · Job Posting (url) · Salary (number, only when the posting stated one)
 *
 * Like bank-notion.ts: never throws, reports through NotionWriteResult, and
 * the caller shows the outcome. A failure here must not lose his click — the
 * posting is already saved by the time this runs.
 */
import type { NotionWriteResult, PostingMeta } from '../../shared/types'
import type { AppEnv } from './notion'
import {
  NOTION_VERSION,
  STATUS_PROP,
  DATE_PROP,
  POSITION_PROP,
  SOURCE_PROP,
  SALARY_PROP,
} from './config'

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
        'Notion cannot see the applications database (404). Share it with the dashboard’s integration (••• → Connections).',
      )
    }
    throw new Error(`Notion ${res.status}: ${String(msg).slice(0, 200)}`)
  }
  return data
}

/**
 * Status can be a `status` property or a `select` one, and the two take
 * different payloads. readStatus() already tolerates both on the way in, so
 * the writer has to as well — guessing puts a 400 in front of him for a
 * schema difference he cannot see. One schema read, then branch.
 */
async function statusProperty(token: string, db: string, value: string): Promise<Record<string, unknown>> {
  const schema = await notion(token, `/databases/${db}`, 'GET')
  const type = schema?.properties?.[STATUS_PROP]?.type
  if (type === 'select') return { [STATUS_PROP]: { select: { name: value } } }
  if (type === 'status') return { [STATUS_PROP]: { status: { name: value } } }
  return {} // no Status column: write the row anyway rather than failing the click
}

/** Midpoint of an advertised range — the honest single number for a band. */
function salaryNumber(meta: PostingMeta): number | null {
  const { min, max } = meta.salary ?? { min: null, max: null }
  if (min !== null && max !== null) return Math.round((min + max) / 2)
  return min ?? max ?? null
}

export async function createApplication(env: AppEnv, meta: PostingMeta): Promise<NotionWriteResult> {
  const token = env.NOTION_TOKEN
  const db = env.NOTION_DATABASE_ID
  if (!token || !db) return { ok: false, error: 'No Notion token or database configured.' }

  try {
    const salary = salaryNumber(meta)
    const properties: Record<string, unknown> = {
      Company: { title: [{ text: { content: meta.company.slice(0, 2000) } }] },
      ...(await statusProperty(token, db, 'Applied')),
      [DATE_PROP]: { date: { start: new Date().toISOString().slice(0, 10) } },
    }
    if (meta.role) properties[POSITION_PROP] = { rich_text: [{ text: { content: meta.role.slice(0, 2000) } }] }
    if (meta.url) properties[SOURCE_PROP] = { url: meta.url }
    if (salary !== null) properties[SALARY_PROP] = { number: salary }

    const page = await notion(token, '/pages', 'POST', { parent: { database_id: db }, properties })
    return { ok: true, pageId: page.id, url: page.url ?? null, created: true, scope: 'company' }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

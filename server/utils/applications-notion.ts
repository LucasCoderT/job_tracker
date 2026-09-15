/**
 * Creating a row in "DB Applications" — the one write the dashboard makes to
 * the database it otherwise only reads.
 *
 * When he presses "Mark applied" on a posting, the application has to exist
 * in Notion or it never reaches the funnel: Notion is still the source of
 * truth and the data-entry surface, and this just saves him retyping what
 * career-ops already knows.
 *
 *   Company (title) · Position · Status → "Applied" · Application Date
 *   · Job Posting (url) · Salary (number, only when the posting stated one)
 *
 * The second write is moving an existing row along — rejected, or on to the
 * next round (updateJobStatus below). Those are the only two: everything else
 * about an application is still edited in Notion.
 *
 * Like bank-notion.ts: never throws, reports through NotionWriteResult, and
 * the caller shows the outcome. A failure here must not lose his click — the
 * posting is already saved by the time this runs.
 */
import type { NotionWriteResult, PostingMeta, JobStatusSnapshot, NotionPage } from '../../shared/types'
import type { AppEnv } from './notion'
import {
  NOTION_VERSION,
  STATUS_PROP,
  DATE_PROP,
  POSITION_PROP,
  SOURCE_PROP,
  SALARY_PROP,
  STAGE_PROP,
  INTERVIEWED_PROP,
  NEXT_ACTION_PROP,
} from './config'
import { readStatus, readSelect } from './notion'

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

/**
 * Today's date where Lucas is, not in UTC.
 *
 * `toISOString().slice(0, 10)` is the UTC date, so every application made after
 * 6pm in Edmonton (5pm in winter) was recorded as the next day. That date is the
 * application date in the Notion tracker, which feeds the EI weekly summary: on
 * 2026-09-11 Tucows and Libellule Monde, applied at 18:11 and 18:13 local, were
 * recorded as 09-12, and an evening application on a Sunday lands in the wrong
 * EI week entirely. `en-CA` formats as YYYY-MM-DD.
 */
const TIMEZONE = 'America/Edmonton'
function localDate(at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** Midpoint of an advertised range — the honest single number for a band. */
function salaryNumber(meta: PostingMeta): number | null {
  const { min, max } = meta.salary ?? { min: null, max: null }
  if (min !== null && max !== null) return Math.round((min + max) / 2)
  return min ?? max ?? null
}

/**
 * An existing Applications row for the same company and role, if there is one.
 *
 * Postings applied to through career-ops get their Notion row from there, so
 * their site meta has no notionPageId. Marking one applied on the site then
 * created a SECOND row dated the day of the click: on 2026-09-10 that
 * duplicated Sophos (applied 09-08) and Escalent (applied 08-28), which
 * double-counted both in every view built on this database, the EI summary
 * included. Exact match on company and position, deliberately: a looser match
 * would link two genuinely different requisitions at the same employer.
 */
async function findExistingApplication(token: string, db: string, meta: PostingMeta): Promise<{ id: string; url: string | null } | null> {
  const filters: unknown[] = [{ property: 'Company', title: { equals: meta.company.slice(0, 2000) } }]
  if (meta.role) filters.push({ property: POSITION_PROP, rich_text: { equals: meta.role.slice(0, 2000) } })
  const res = await notion(token, `/databases/${db}/query`, 'POST', {
    filter: filters.length > 1 ? { and: filters } : filters[0],
    page_size: 1,
  })
  const page = res?.results?.[0]
  return page ? { id: page.id, url: page.url ?? null } : null
}

export async function createApplication(env: AppEnv, meta: PostingMeta): Promise<NotionWriteResult> {
  const token = env.NOTION_TOKEN
  const db = env.NOTION_DATABASE_ID
  if (!token || !db) return { ok: false, error: 'No Notion token or database configured.' }

  try {
    // Link rather than duplicate. A failed lookup falls through to creating the
    // row: a possible duplicate is recoverable, a lost application record is not.
    const existing = await findExistingApplication(token, db, meta).catch(() => null)
    if (existing) return { ok: true, pageId: existing.id, url: existing.url, created: false, scope: 'company' }

    const salary = salaryNumber(meta)
    const properties: Record<string, unknown> = {
      Company: { title: [{ text: { content: meta.company.slice(0, 2000) } }] },
      ...(await statusProperty(token, db, 'Applied')),
      [DATE_PROP]: { date: { start: localDate() } },
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

// ---- Moving an application along ----

/** Notion ids arrive dashed or not; the parent check has to compare like with like. */
const bareId = (id: string | null | undefined) => String(id ?? '').replace(/-/g, '').toLowerCase()

/** The four properties a status change touches, read off a page as they are. */
export function snapshotOf(page: NotionPage): JobStatusSnapshot {
  const checkbox = page.properties?.[INTERVIEWED_PROP]
  return {
    status: readStatus(page),
    stage: readSelect(page, STAGE_PROP),
    interviewed: checkbox?.type === 'checkbox' ? !!checkbox.checkbox : false,
    nextAction: readSelect(page, NEXT_ACTION_PROP),
  }
}

/**
 * Reads one row — and refuses it unless it belongs to DB Applications.
 *
 * The route takes a page id from the browser. Behind Access that is only ever
 * him, but a page id is not proof of what the page is: without this a stale
 * link or a bug could set "Status: Rejected" on any page the integration can
 * see, and the answer bank and the EI log are both shared with it.
 */
export async function readApplication(env: AppEnv, pageId: string): Promise<NotionPage> {
  const token = env.NOTION_TOKEN
  const db = env.NOTION_DATABASE_ID
  if (!token || !db) throw new Error('No Notion token or database configured.')
  const page = await notion(token, `/pages/${pageId}`, 'GET')
  if (bareId(page?.parent?.database_id) !== bareId(db)) {
    throw Object.assign(new Error('That page is not an application in DB Applications.'), { statusCode: 422 })
  }
  return page
}

/**
 * Writes a snapshot onto a row. Each property is written in the shape the
 * page itself says it has — Status may be `select` or `status` — and a
 * property the database does not have is skipped rather than failing the
 * change: losing a rejection over a missing "Next Action" column is worse
 * than not setting the column.
 */
export async function updateJobStatus(env: AppEnv, page: NotionPage, next: JobStatusSnapshot): Promise<NotionPage> {
  const token = env.NOTION_TOKEN!
  const props = page.properties ?? {}
  const selectLike = (name: string, value: string | null) => {
    const type = props[name]?.type
    if (type === 'status') return value ? { status: { name: value } } : undefined // a status cannot be cleared
    if (type === 'select') return { select: value ? { name: value } : null }
    return undefined
  }

  const properties: Record<string, unknown> = {}
  const put = (name: string, value: unknown) => {
    if (value !== undefined) properties[name] = value
  }
  put(STATUS_PROP, selectLike(STATUS_PROP, next.status))
  put(STAGE_PROP, selectLike(STAGE_PROP, next.stage))
  put(NEXT_ACTION_PROP, selectLike(NEXT_ACTION_PROP, next.nextAction))
  if (props[INTERVIEWED_PROP]?.type === 'checkbox') properties[INTERVIEWED_PROP] = { checkbox: next.interviewed }

  return await notion(token, `/pages/${page.id}`, 'PATCH', { properties })
}

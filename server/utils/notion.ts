/**
 * Notion access + property readers + derivation helpers.
 * Ported from the original Worker; logic unchanged, now typed.
 */
import type { H3Event } from 'h3'
import type { NotionPage } from '../../shared/types'
import {
  NOTION_VERSION,
  STATUS_PROP,
  DATE_PROP,
  NEXT_ACTION_PROP,
  INTERVIEWED_PROP,
  STATUS_BUCKETS,
  DEFAULT_STALE_DAYS,
} from './config'

// ---- Cloudflare env / bindings ----

// Minimal shape of the KV namespace we use — avoids a hard dep on
// @cloudflare/workers-types for this one binding.
export interface KVNamespace {
  // arrayBuffer is how posting artifacts (a CV is a ~110KB PDF) come back;
  // packs only ever store text.
  get(key: string, type?: 'text' | 'json' | 'arrayBuffer'): Promise<any>
  put(key: string, value: string | ArrayBuffer, opts?: { metadata?: unknown }): Promise<void>
  delete(key: string): Promise<void>
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string; metadata?: unknown }[]
    list_complete?: boolean
    cursor?: string
  }>
}

export interface AppEnv {
  NOTION_TOKEN?: string
  NOTION_DATABASE_ID?: string
  // Interview packs: the answer-bank database and, optionally, a token from
  // an integration that is connected to it (falls back to NOTION_TOKEN).
  NOTION_BANK_DATABASE_ID?: string
  NOTION_BANK_TOKEN?: string
  STALE_DAYS?: string
  NOTION_VIEW_URL?: string
  SNAPSHOTS?: KVNamespace
  PACKS?: KVNamespace
  // Job postings career-ops pushes up before they are applied to.
  POSTINGS?: KVNamespace
}

// On Cloudflare, secrets + vars + bindings live on the request's cloudflare
// env (populated locally by nitro-cloudflare-dev from wrangler config +
// .dev.vars). We merge process.env under it so local dev also works from a
// plain .env file (Nuxt auto-loads it) — the cloudflare env wins on overlap,
// which keeps live bindings like the SNAPSHOTS KV handle.
export function getCloudflareEnv(event: H3Event): AppEnv {
  const proc = (globalThis as any).process?.env ?? {}
  const cf = (event.context as any)?.cloudflare?.env ?? {}
  return { ...proc, ...cf } as AppEnv
}

export function resolveStaleDays(env: AppEnv): number {
  const n = Number(env.STALE_DAYS)
  return n > 0 ? n : DEFAULT_STALE_DAYS
}

// Best-effort env for NON-request contexts (the scheduled snapshot task).
// Cloudflare only exposes bindings during the request lifecycle, so there is
// no guaranteed accessor here — we probe the globals the cloudflare_module
// preset is known to set, then fall back to process.env for local dev. If this
// comes back without SNAPSHOTS on a real deploy, seed via the Access-gated
// GET /api/snapshot route instead (that path has a proper request context).
export function getTaskEnv(): AppEnv {
  const g = globalThis as any
  return (g.__env__ ?? g.__cf_env__ ?? g.process?.env ?? {}) as AppEnv
}

// ---- Property readers ----

export function readStatus(page: NotionPage): string | null {
  const prop = page.properties?.[STATUS_PROP]
  if (!prop) return null
  if (prop.type === 'status') return prop.status?.name ?? null
  if (prop.type === 'select') return prop.select?.name ?? null
  return null
}

export function readSelect(page: NotionPage, name: string): string | null {
  const prop = page.properties?.[name]
  if (prop?.type === 'select') return prop.select?.name ?? null
  if (prop?.type === 'status') return prop.status?.name ?? null
  return null
}

export function readTitle(page: NotionPage): string {
  for (const prop of Object.values(page.properties || {}) as any[]) {
    if (prop.type === 'title') {
      return (prop.title || []).map((t: any) => t.plain_text).join('').trim()
    }
  }
  return ''
}

export function readRichText(page: NotionPage, name: string): string {
  const prop = page.properties?.[name]
  if (prop?.type === 'rich_text') {
    return (prop.rich_text || []).map((t: any) => t.plain_text).join('').trim()
  }
  return ''
}

export function readUrl(page: NotionPage, name: string): string | null {
  const prop = page.properties?.[name]
  return prop?.type === 'url' ? prop.url || null : null
}

export function readNumber(page: NotionPage, name: string): number | null {
  const prop = page.properties?.[name]
  return prop?.type === 'number' && typeof prop.number === 'number' ? prop.number : null
}

export function readDateMs(page: NotionPage): number | null {
  const start = page.properties?.[DATE_PROP]?.date?.start
  if (!start) return null
  const ms = Date.parse(start)
  return Number.isFinite(ms) ? ms : null
}

export function readInterviewed(page: NotionPage): boolean {
  const prop = page.properties?.[INTERVIEWED_PROP]
  if (prop?.type === 'checkbox' && prop.checkbox) return true
  // A row with a Furthest Stage set has demonstrably interviewed, so the stage
  // property alone is enough — the checkbox is belt-and-braces, not required.
  return readStage(page) !== null
}

// How deep the process actually got. Ordinal, not semantic, so companies with
// different round names stay comparable. Null = never reached an interview.
export function readStage(page: NotionPage): string | null {
  const prop = page.properties?.[STAGE_PROP]
  const name = prop?.type === 'select' ? (prop.select?.name ?? null) : null
  return name && STAGE_ORDER.includes(name) ? name : null
}

export function readStageRank(page: NotionPage): number {
  const name = readStage(page)
  return name ? STAGE_ORDER.indexOf(name) + 1 : 0
}

// ---- Derivation helpers ----

export function classify(
  page: NotionPage,
  { staleMs, now }: { staleMs: number; now: number },
): string | null {
  const name = (readStatus(page) || '').trim().toLowerCase()
  const bucket = STATUS_BUCKETS[name]
  if (bucket === 'applied') {
    const ms = readDateMs(page)
    const isStale = ms !== null && now - ms > staleMs
    return isStale ? 'noAnswer' : 'awaiting'
  }
  return bucket ?? null
}

// Keyword-classify a Position title into one of four lanes, to compare reply
// rates by role type. Heuristic + priority-ordered — titles mix terms
// ("Senior AI Engineer (Backend-first)"), so first match wins:
//   1. Support/QA/non-eng → Other (so "Python QA Engineer" isn't "Backend")
//   2. AI/ML   — any ai/ml/llm signal (the lane we most want to isolate)
//   3. Full-Stack
//   4. Backend — backend/python/django/node
//   5. Other   — generic "Software Engineer/Developer", no lane signal
export type RoleType = 'Full-Stack' | 'Backend' | 'AI/ML' | 'Other'
export const ROLE_ORDER: RoleType[] = ['Full-Stack', 'Backend', 'AI/ML', 'Other']

export function classifyRole(position: string): RoleType {
  const s = (position || '').toLowerCase()
  if (!s) return 'Other'
  if (/support|help ?desk|desktop|\bqa\b|quality (control|assurance)|tester|technical writer/.test(s)) return 'Other'
  if (/\bai\b|\bml\b|\bllms?\b|machine learning|applied ai|genai|a\.i\./.test(s)) return 'AI/ML'
  if (/full[ -]?stack/.test(s)) return 'Full-Stack'
  if (/back[ -]?end|django|node\.?js|\bpython\b/.test(s)) return 'Backend'
  return 'Other'
}

// Registrable-ish domain: ca.indeed.com → indeed.com, www.linkedin.com → linkedin.com
// Registrable domain of a URL (e.g. "job-boards.greenhouse.io" → "greenhouse.io").
export function sourceDomain(url: string | null): string | null {
  if (!url) return null
  try {
    const host = new URL(url).hostname.toLowerCase()
    const parts = host.split('.')
    return parts.length > 2 ? parts.slice(-2).join('.') : host
  } catch {
    return null
  }
}

// Friendly "source channel" of an application, derived from its Job Posting
// URL. Known job boards and ATS vendors get a readable label; anything else
// (a company's own careers domain, a referral link, etc.) falls back to its
// registrable domain. This is the apply/posting channel — a good proxy for
// where a role came from without a manual per-row field. Returns null for
// rows with no Job Posting URL so they can be counted as "unknown" upstream.
const CHANNEL_BY_DOMAIN: Record<string, string> = {
  'linkedin.com': 'LinkedIn',
  'indeed.com': 'Indeed',
  'remoteok.com': 'RemoteOK',
  'ashbyhq.com': 'Ashby',
  'greenhouse.io': 'Greenhouse',
  'lever.co': 'Lever',
  'myworkdayjobs.com': 'Workday',
  'myworkdaysite.com': 'Workday',
  'rippling.com': 'Rippling',
  'breezy.hr': 'Breezy',
  'wellfound.com': 'Wellfound',
  'angel.co': 'Wellfound',
  'jobbank.gc.ca': 'Job Bank',
  'hrsdc-rhdcc.gc.ca': 'Job Bank',
}

export function channelOf(url: string | null): string | null {
  const domain = sourceDomain(url)
  if (!domain) return null
  return CHANNEL_BY_DOMAIN[domain] ?? domain
}

// Monday of the week containing the given ISO date (UTC).
export function weekStartISO(iso: string): string | null {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z')
  if (!Number.isFinite(d.getTime())) return null
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day)
  return d.toISOString().slice(0, 10)
}

// ---- Notion query (paginated) ----

export async function queryAllPages(env: AppEnv): Promise<NotionPage[]> {
  const results: NotionPage[] = []
  let cursor: string | undefined

  do {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${env.NOTION_DATABASE_ID}/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
      },
    )

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`${res.status} ${body.slice(0, 200)}`)
    }

    const data = (await res.json()) as { results: NotionPage[]; has_more: boolean; next_cursor: string }
    results.push(...data.results)
    cursor = data.has_more ? data.next_cursor : undefined
  } while (cursor)

  return results
}

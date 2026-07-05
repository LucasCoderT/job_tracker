/**
 * Payload shapes shared between the Worker (server/) and the dashboard (app/).
 * This is the single source of truth for the /api/stats response — the server
 * builds it in aggregate(), the client consumes it in useStats().
 */

// ---- Notion (loose — we only read a handful of properties) ----

export interface NotionPage {
  url?: string | null
  properties?: Record<string, any>
  [key: string]: any
}

// ---- Funnel buckets ----

export type BucketKey =
  | 'awaiting'
  | 'pending'
  | 'interviewed'
  | 'progressing'
  | 'offerAccepted'
  | 'offerDeclined'
  | 'rejected'
  | 'noAnswer'

export interface Counts {
  awaiting: number
  pending: number
  interviewed: number
  progressing: number
  offerAccepted: number
  offerDeclined: number
  rejected: number
  rejectedAfterInterview: number
  noAnswer: number
  unknown: number
}

export interface Bucket {
  key: BucketKey
  label: string
  color: string
  count: number
}

// ---- Rows ----

export interface Job {
  company: string
  position: string
  bucket: BucketKey
  date: string | null
  ageDays: number | null
  url: string | null
  salary: number | null
  source: string | null // registrable domain, e.g. "ashbyhq.com"
  nextAction: string | null
}

export interface AttentionItem extends Job {
  reason: 'followup' | 'aging'
}

// ---- Charts ----

export interface WeekPoint {
  week: string
  applied: number
  replied: number
}

export interface Source {
  domain: string
  total: number
  replied: number
}

export interface RoleStat {
  role: string
  total: number
  replied: number
}

export interface SalaryGroup {
  n: number
  median: number
  min: number
  max: number
}

// Salary (annual $) of applied roles, split by whether they ever replied.
// heardBack + silent partition all rows that have a salary set.
export interface SalaryContext {
  overall: SalaryGroup
  heardBack: SalaryGroup
  silent: SalaryGroup
}

export interface Metrics {
  heardBack: number
  interviewed: number
  offers: number
  heardBackRate: number
  interviewRate: number
  offerRate: number
}

export interface SankeyNodeSpec {
  id: string
  label: string
}

export interface SankeyLinkSpec {
  source: string
  target: string
  value: number
}

export interface SankeySpec {
  nodes: SankeyNodeSpec[]
  links: SankeyLinkSpec[]
}

// ---- Top-level /api/stats payload ----

export interface Stats {
  generatedAt: string
  staleDays: number
  total: number
  counts: Counts
  buckets: Bucket[]
  jobs: Job[]
  attention: AttentionItem[]
  weekly: WeekPoint[]
  sources: Source[]
  roles: RoleStat[]
  salary: SalaryContext
  metrics: Metrics
  sankey: SankeySpec
}

// ---- /api/history payload ----

export interface Snapshot {
  date: string
  total: number
  counts: Counts
  metrics: Metrics
}

export interface HistoryResponse {
  enabled: boolean
  snapshots: Snapshot[]
}

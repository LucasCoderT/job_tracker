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
  pendingAfterInterview: number
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
  id: string // Notion page id of the application row; keys the interview pack
  company: string
  position: string
  bucket: BucketKey
  date: string | null
  ageDays: number | null
  url: string | null
  salary: number | null
  source: string | null // registrable domain, e.g. "ashbyhq.com"
  nextAction: string | null
  stage: string | null // furthest interview round reached; null = never interviewed
}

// One rung of the interview-depth ladder: how many processes got this far.
export interface StageStat {
  stage: string
  reached: number // processes that got AT LEAST this far
  stoppedHere: number // processes whose furthest point was exactly this rung
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
  stages: StageStat[]
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

// ---- Interview packs (/api/packs) ----
//
// A pack is everything InterviewHelper needs for one interview: the answer
// bank the app reads (same JSON shape as its bank files) plus any exports the
// desktop worker publishes (prep notes, question banks). Packs live in the
// PACKS KV namespace, keyed by the application's Notion page id, so the web
// can request, view and edit them from any device while the Mac builds them.

export type PackStatus = 'requested' | 'building' | 'done' | 'failed'

export interface Beat {
  text: string
  keys: string[]
  stance?: 'DELIBERATE' | 'GAP' | 'MEASURED' | 'UNMEASURED' | string
}

export interface Answer {
  id: string
  question: string
  cues: string[]
  beats: Beat[]
  script?: string
  avoid?: string[]
  minSeconds?: number
}

export interface PresentationSection {
  answerId: string
  budgetSeconds: number
}

export interface AnswerBank {
  title?: string
  answers: Answer[]
  avoid?: string[]
  presentation?: PresentationSection[]
}

export interface PackExport {
  name: string // file name, e.g. "round2-prep.md"
  contentType: string
  bytes: number
  updatedAt: string
}

export interface PackMeta {
  jobId: string
  company: string
  position: string
  slug: string // the bank slug the app files it under
  status: PackStatus
  note: string // what the requester asked for ("round 2, hiring manager")
  requestedAt: string
  updatedAt: string
  builtAt: string | null
  error: string | null
  answers: number
  beats: number
  exports: PackExport[]
}

export interface PacksResponse {
  enabled: boolean
  packs: PackMeta[]
}

export interface PackDetail {
  meta: PackMeta
  bank: AnswerBank | null
  lint: string[]
}

// What an answer edit on the web reports back about its Notion write-back.
export type NotionWriteResult =
  | { ok: true; pageId: string; url: string | null; created: boolean; scope: 'company' | 'universal' }
  | { ok: false; error: string }

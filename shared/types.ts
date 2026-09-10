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

// ---- Job postings (/api/postings) ----
//
// A posting is a job career-ops found, scored and judged worth a look —
// pushed up BEFORE it is applied to. It arrives thin from the 07:00 standup
// (score, why, comp, geo, stack) and is upgraded in place when a full
// evaluation report is written later, gaining the analysis and the JD text.
//
// Keyed by sha256(normalizeUrl(url)).slice(0,16): normalizeUrl is career-ops's
// canonical posting key (url-key.mjs), so both sides derive the same id from
// the same posting without a lookup.
//
// Two orthogonal fields: `state` is his decision, `pack` is the Mac's
// progress building the CV + cover letter. Merging them would make
// "dismissed, but the pack already built" unrepresentable.

export type PostingState = 'new' | 'dismissed' | 'applied'
export type PostingPack = 'none' | 'requested' | 'building' | 'done' | 'failed'

export interface PostingArtifact {
  name: string // file name, e.g. "Lucas-Lukowski-Acme-CV.pdf"
  contentType: string
  bytes: number
  kind: 'cv' | 'cover-letter' | 'notes' | 'other'
  updatedAt: string
}

export interface PostingSalary { min: number | null; max: number | null; currency: string | null }

/** One requirement the JD stated, and how well he matches it. */
export interface PostingRequirement {
  requirement: string
  evidence?: string
  importance?: string
  match?: string
}

/**
 * career-ops's evaluation, mirroring the report's `## Machine Summary` fence.
 * Every field is optional and every enum is a free string: the real corpus
 * spells legitimacy five ways and risk seven, and validating strictly would
 * reject about a third of it.
 */
export interface PostingAnalysis {
  finalDecision?: string
  archetype?: string
  legitimacy?: string
  riskLevel?: string
  confidence?: string
  workAuth?: string
  nextAction?: string
  advertisedComp?: string
  reportsTo?: string
  via?: string | null
  companyConfidential?: boolean
  hardStops: string[]
  softGaps: string[]
  topStrengths: string[]
  discardReasons: string[]
  requirements: PostingRequirement[]
  risk: Record<string, string>
  /**
   * Every other key the report carried, flattened to strings.
   *
   * The Machine Summary schema has drifted well past what batch-prompt.md
   * documents — recent reports carry comp_posted, comp_anchor_cad,
   * geo_eligible, stack_primary, ats, applicants and no final_decision or
   * hard_stops at all. Mapping a fixed list would silently drop most of what
   * a current evaluation actually says, so anything unmapped is carried
   * through verbatim and rendered as-is.
   */
  extra: Record<string, string>
}

export interface PostingMeta {
  id: string
  url: string
  company: string
  role: string
  location: string
  source: string // the board it came from, e.g. "linkedin", "indeed", "ashby"
  score: number | null // career-ops's global score, 0–5
  why: string // the one-line justification for the score
  comp: string // as advertised, verbatim — never estimated
  geo: string
  stack: string
  salary: PostingSalary | null
  postedAt: string | null
  firstSeen: string | null
  reportNum: string | null // the career-ops report this was upgraded from
  state: PostingState
  pack: PostingPack
  packNote: string
  packError: string | null
  packRequestedAt: string | null
  packBuiltAt: string | null
  notionPageId: string | null // set once applied; what an interview pack keys on
  appliedAt: string | null
  hasJD: boolean
  hasAnalysis: boolean
  artifacts: PostingArtifact[]
  createdAt: string
  updatedAt: string
}

export interface PostingsResponse { enabled: boolean; postings: PostingMeta[] }

export interface PostingDetail { meta: PostingMeta; jd: string | null; analysis: PostingAnalysis | null }

/** POST /:id/applied — the row went into Notion (or said why it didn't). */
export interface PostingApplyResult { meta: PostingMeta; notion: NotionWriteResult }

/** POST /api/postings — `created: false` means this URL was already here. */
export interface PostingCreateResult { meta: PostingMeta; created: boolean }

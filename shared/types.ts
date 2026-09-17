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
  /** The pin: the beat that carries the WHY. `[WHY]` in the line format. */
  pin?: boolean
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
  /**
   * The employer's own posting for this job, when the one it was found at is an
   * aggregator. Applications sent on the employer's page reach a screen at
   * 15.4% against 4.9% through LinkedIn and Indeed, so when this is set it is
   * the link to apply through — `url` stays as the place it was discovered.
   * Resolved on the Mac by career-ops's resolve-employer-req.mjs.
   */
  employerUrl: string | null
  notionPageId: string | null // set once applied; what an interview pack keys on
  appliedAt: string | null
  /**
   * When he first opened the brief. Unset means he has not looked at it yet,
   * which is what the dashboard's unread marker reads. Server-side rather than
   * localStorage on purpose: he triages on a phone and acts on a laptop, and a
   * posting read this morning should not be bold again this afternoon.
   */
  openedAt: string | null
  /**
   * When he dismissed it — written only by POST /:id/state. `updatedAt` cannot
   * stand in: every producer push stamps it, so it says when the Mac last
   * touched the posting, not when he decided anything.
   */
  dismissedAt: string | null
  hasJD: boolean
  /**
   * Where the JD came from — "greenhouse", "lever", "ashby", "linkedin",
   * "page", "pasted", or "career-ops" when an evaluation pushed it — and when.
   * Captured straight from the posting, so it no longer waits on an evaluation.
   */
  jdSource: string | null
  jdCapturedAt: string | null
  /** Why the last capture failed ("Indeed blocks automated fetches"), until one works. */
  jdError: string | null
  /** When a capture was last tried, so a producer push does not retry every half hour. */
  jdAttemptedAt: string | null
  hasAnalysis: boolean
  /** Supplemental application questions: how many, and how the draft is going. */
  questions: number
  answered: number
  answerStatus: AnswerStatus
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

// ---- Application questions (/api/postings/:id/questions) ----
//
// The supplemental questions an application form asks — "why here", "describe
// a system you owned", salary expectations, work authorization. He pastes them
// off the form; the Mac drafts answers from his CV and the JD through
// career-ops's modes/apply.md; he reads, edits and copies them on the phone.
//
// Same shape of pipeline as an apply pack, and deliberately a separate status
// from it: the CV and the form answers are built by different runs and either
// can be wanted without the other.

export type AnswerStatus = 'none' | 'requested' | 'building' | 'done' | 'failed'

/**
 * First-call preparation. Seven of the ten applications that ever reached an
 * interview stopped at the first screen, and it is the one stage with no
 * tooling pointed at it.
 *
 * A prompt is either `standing` — the handful of questions every screen asks,
 * whose answers carry forward from the last call he prepared for — or `probe`,
 * assembled from this posting's own evaluation: the hard stops and the
 * high-importance requirements it recorded him as weak on, which are what an
 * interviewer will actually push on.
 *
 * The site stores and edits his words here and generates none of them, exactly
 * as the answer bank does.
 */
export type ScreenPromptKind = 'standing' | 'probe' | 'asked'
export interface ScreenPrompt {
  id: string
  prompt: string
  kind: ScreenPromptKind
  /** Why this is being asked of him — for a probe, the evaluation's own words. */
  because: string
  answer: string
  /** `carried` = his answer from the last screen he prepared, not yet revisited. */
  source: 'blank' | 'carried' | 'edited'
  updatedAt: string
}
export interface ScreenPrep {
  prompts: ScreenPrompt[]
  updatedAt: string
}
/**
 * Questions he was actually asked on a call, recorded afterwards. At one
 * interview per eighteen applications these are the rarest input the system
 * gets, and until now none of it was captured anywhere.
 */
export interface ScreenAsked {
  questions: { id: string; text: string; company: string; at: string }[]
  updatedAt: string
}

/** The latest version of each standing answer, so the next call starts from it. */
export interface ScreenStanding {
  answers: Record<string, { answer: string; updatedAt: string }>
  updatedAt: string
}

export interface PostingQuestion {
  id: string // stable hash of the question text, so a re-paste keeps answers
  question: string
  answer: string // '' until drafted
  /** Where the current answer text came from. */
  source: 'pasted' | 'drafted' | 'edited'
  updatedAt: string
}

export interface PostingQuestions {
  questions: PostingQuestion[]
  status: AnswerStatus
  /** Steer the whole draft — tone, what to emphasise, anything to avoid. */
  note: string
  requestedAt: string | null
  builtAt: string | null
  error: string | null
  updatedAt: string
}

// ---- EI job-search activity ----
//
// His record of job-search activity for Service Canada, kept in the Notion
// "EI Job Search Activity Log". Every automation on this project does work
// *for* him — the Mac evaluates postings, drafts CVs, drafts form answers,
// often while he is asleep — and none of that is his job-search time. So the
// site assembles candidate rows out of things it can prove *he* did (pressed
// Mark applied, requested a pack, dismissed a posting, pasted a form's
// questions), shows the evidence for each, and leaves `timeSpent` empty.
// He sets the hours and confirms; nothing is written until he does.

/** The Method select, verbatim from the Notion database. */
export type EiMethod =
  | 'Networking'
  | 'Searched online'
  | 'Applied online'
  | 'Email application'
  | 'Attended interview'
  | 'Resume/cover letter prep'

/** The Outcome select, verbatim from the Notion database. */
export type EiOutcome = 'Waiting on reply' | 'Applied' | 'No suitable postings found' | 'Interview scheduled'

/** The Time Spent select. A closed set — Notion rejects anything else. */
export type EiTimeSpent = '30 min' | '1 hour' | '1.5 hours' | '2 hours'

export const EI_TIME_OPTIONS: EiTimeSpent[] = ['30 min', '1 hour', '1.5 hours', '2 hours']

/** One proposed row, with what the site saw that makes it a candidate. */
export interface EiCandidate {
  /** Stable across regenerations of the same week, so a dismissal sticks. */
  key: string
  date: string // YYYY-MM-DD, America/Edmonton
  method: EiMethod
  activity: string
  /** The employer this row is about — what a logged row is matched against. */
  subject: string
  notes: string
  outcome: EiOutcome
  /** What the site actually observed, in local time. Shown, never inferred. */
  evidence: string[]
  /**
   * A time to start from, worked out from what the evidence shows (how many
   * applications, how many packs), with the reasoning beside it. Only ever a
   * starting value on screen: nothing is logged until he presses Log, and
   * what goes to Notion is what he left in the box.
   */
  suggested: EiTimeSpent
  suggestedWhy: string
  /** A row already in Notion that looks like this one — do not double-log. */
  alreadyLogged: boolean
  /**
   * Other entries the log already holds for this day and method. His own rows
   * are freehand and often summarise several applications at once, which no
   * matcher can pair up reliably — so the page shows them and he decides.
   */
  sameDayLogged: string[]
}

/** A row already in the Notion log, for the "already recorded" list. */
export interface EiLogged {
  date: string
  method: string
  activity: string
  timeSpent: string | null
}

export interface EiWeek {
  enabled: boolean
  monday: string
  sunday: string
  /** Today in his timezone, so "Log today" never has to work out Edmonton. */
  today: string
  candidates: EiCandidate[]
  logged: EiLogged[]
  /** Set when the log cannot be read — the page says so rather than inventing. */
  error: string | null
}

/** What he confirms. `timeSpent` is required: the server never fills it in. */
export interface EiEntryInput {
  date: string
  method: EiMethod
  activity: string
  notes?: string
  outcome: EiOutcome
  timeSpent: EiTimeSpent
}

export interface EiWriteResult {
  written: number
  failed: { activity: string; error: string }[]
}

// ---- Moving an application along (rejected / next round) ----

/** The four Notion properties a status change touches, as they stand. */
export interface JobStatusSnapshot {
  status: string | null
  stage: string | null
  interviewed: boolean
  nextAction: string | null
}

/**
 * `reject` and `advance` are the two moves; `restore` puts back a snapshot the
 * route returned earlier, which is what Undo sends.
 */
export type JobStatusAction = 'reject' | 'advance' | 'restore'

export interface JobStatusResult {
  /** The row as the board builds it, straight from Notion's PATCH response. */
  job: Job
  /** What was there before — Undo sends this back as-is. */
  previous: JobStatusSnapshot
  current: JobStatusSnapshot
}

/**
 * A status change he made from the tracker (rejected, moved on a round),
 * kept so the EI day can see it. Notion keeps no history of its own, and its
 * last_edited_time is useless here: the Mac's email classifier edits the same
 * rows, and its work is not his job-search time.
 */
export interface ActivityEvent {
  at: string
  day: string // YYYY-MM-DD, America/Edmonton
  pageId: string
  company: string
  position: string
  action: 'reject' | 'advance'
  stage: string | null
}

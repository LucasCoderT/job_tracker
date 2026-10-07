/**
 * The interview ladder, shared by the Worker (which validates a status change)
 * and the browser (which offers it), so the menu can never offer a move the
 * server will refuse.
 *
 * "Progressing" is not a Notion status. The live Status enum is Applied ·
 * Interviewing · On Hold · Offer · Accepted · Rejected; how far a process got
 * lives in `Furthest Stage`, and moving forward means three properties move
 * together — Status, Furthest Stage and the Interviewed checkbox.
 */

// Order IS the ladder order. Ordinal rather than semantic because round names
// differ per company and ordinal labels stay comparable across all of them.
export const STAGE_ORDER = ['Round 1 — Screen', 'Round 2', 'Round 3+', 'Offer'] as const
export type Stage = (typeof STAGE_ORDER)[number]

export const stageRank = (stage: string | null | undefined): number =>
  stage ? STAGE_ORDER.indexOf(stage as Stage) : -1

/**
 * The rungs a job can be moved to from where it is. Furthest Stage only goes
 * up — it records how deep a process got, and a rejection at Round 2 still
 * reached Round 2. Two repeats are allowed:
 *
 *  - **Round 3+** again, because it is a range: a fourth and fifth round are
 *    still "3+", and marking each one is how he records them.
 *  - **the current rung** on a job that is not actively interviewing, which is
 *    how a rejected or paused process is reopened where it stopped.
 *
 * Going *down* a rung is only possible through undo, which restores exactly
 * what was there before.
 */
export function reachableStages(stage: string | null, activelyInterviewing: boolean, offerHeld = false): Stage[] {
  const cur = stageRank(stage)
  return STAGE_ORDER.filter((s, i) => {
    if (i > cur) return true
    if (i < cur) return false
    if (s === 'Offer') return !offerHeld
    return s === 'Round 3+' || !activelyInterviewing
  })
}

/** Where "next round" goes from here — one tap, the common case. */
export function nextStage(stage: string | null): Stage {
  const cur = stageRank(stage)
  if (cur < 0) return 'Round 1 — Screen'
  // A round after Round 3+ is still Round 3+; an offer is a separate, deliberate
  // choice, never what "next round" means.
  if (STAGE_ORDER[cur] === 'Round 3+' || STAGE_ORDER[cur] === 'Offer') return STAGE_ORDER[cur]!
  return STAGE_ORDER[cur + 1]!
}

/**
 * Every way an application's status can be changed from the site. `reject` and
 * `advance` were the first two; the rest arrived on 2026-10-07 with the status
 * control on the posting brief.
 */
export type StatusAction = 'reject' | 'advance' | 'hold' | 'accept' | 'decline' | 'reopen' | 'restore'

type StatusView = { bucket: string; stage: string | null; status?: string | null }

const statusOf = (job: StatusView) => (job.status ?? '').trim().toLowerCase()

/**
 * Where an application stands, in words. Reads the Notion status as well as
 * the bucket, because two buckets hide a distinction he cares about: "On Hold"
 * counts as pending for the funnel, and a bare "Offer" counts the same as an
 * accepted one.
 */
export function jobStatusLabel(job: StatusView): string {
  const status = statusOf(job)
  if (job.bucket === 'rejected') return job.stage ? `Rejected after ${job.stage}` : 'Rejected'
  if (status === 'on hold') return job.stage ? `On hold at ${job.stage}` : 'On hold'
  if (job.bucket === 'offerDeclined') return 'Offer declined'
  if (status === 'accepted' || status === 'offer accepted') return 'Offer accepted'
  if (job.bucket === 'offerAccepted') return 'Offer received'
  if (job.stage) return job.stage
  if (job.bucket === 'noAnswer') return 'No answer'
  if (job.bucket === 'awaiting') return 'Awaiting reply'
  return 'Heard back'
}

/**
 * The moves on offer from where a job is, used by the menu and checked again
 * by the route, for the same reason reachableStages is shared.
 *
 *  - `hold`    the employer paused it. Not from rejected, held, or decided.
 *  - `reopen`  a rejection that was wrong, or a hold that ended.
 *  - `accept` / `decline`  his decision on an offer: only once there is one.
 */
export function statusMoves(job: StatusView) {
  const status = statusOf(job)
  const rejected = job.bucket === 'rejected'
  const held = status === 'on hold'
  const decided = status === 'accepted' || status === 'offer accepted' || job.bucket === 'offerDeclined'
  const offered = job.stage === 'Offer' || job.bucket === 'offerAccepted' || job.bucket === 'offerDeclined'
  const interviewing = (job.bucket === 'interviewed' || job.bucket === 'progressing') && !held
  return {
    rungs: decided ? [] : reachableStages(job.stage, interviewing, job.bucket === 'offerAccepted'),
    reject: !rejected && !decided,
    hold: !rejected && !held && !decided,
    reopen: rejected || held,
    accept: offered && !(status === 'accepted' || status === 'offer accepted'),
    decline: offered && job.bucket !== 'offerDeclined',
  }
}

/** Whether there is anything to offer: a decided offer that was accepted and declined both ways has no moves left. */
export function canChangeStatus(job: StatusView): boolean {
  const m = statusMoves(job)
  return m.rungs.length > 0 || m.reject || m.hold || m.reopen || m.accept || m.decline
}

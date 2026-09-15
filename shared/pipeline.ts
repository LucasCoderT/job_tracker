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

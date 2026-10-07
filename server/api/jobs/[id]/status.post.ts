/**
 * POST /api/jobs/:id/status — mark an application rejected, or moved on a round.
 *
 * Body: { action: 'reject' }
 *     | { action: 'advance', stage?: 'Round 1 — Screen' | 'Round 2' | 'Round 3+' | 'Offer' }
 *     | { action: 'hold' | 'accept' | 'decline' | 'reopen' }
 *     | { action: 'restore', previous: JobStatusSnapshot }      ← Undo
 *
 * What each one writes to the Notion row:
 *
 *   reject   Status → Rejected · Next Action → Nothing
 *            Furthest Stage and Interviewed are left alone: a rejection at
 *            Round 2 still reached Round 2, and that is what routes it through
 *            "rejected after interview" instead of counting it as a form
 *            rejection. Clearing them would quietly lower the interview rate.
 *   advance  Furthest Stage → the chosen rung (default: the next one)
 *            · Status → Interviewing, or Offer at the top rung
 *            · Interviewed → ✓ · Next Action → Prepare Interview, or Decide
 *   hold     Status → On Hold · Next Action → Waiting. The employer paused it;
 *            how far it got is left alone, like a rejection.
 *   accept   Status → Accepted · Furthest Stage → Offer · Interviewed → ✓
 *            · Next Action → Nothing
 *   decline  Status → Offer Declined (the same three, his decision the other
 *            way). Status is a select, so Notion adds the option on first use.
 *   reopen   a rejection that was wrong, or a hold that ended: back to
 *            Interviewing where it has a stage, else to Applied. Un-rejecting
 *            to Applied clears Replied: the rejection was the reply, and it was
 *            wrong. A hold that ends keeps its date, since someone did write.
 *   restore  exactly the snapshot given — the only way a stage goes back down
 *
 * reject and advance both set Replied to today unless an earlier date is
 * already there, so Undo also puts Replied back.
 *
 * Returns the row rebuilt the way the board builds it, plus what was there
 * before, so the page can move the card at once and offer Undo without a
 * second round trip. The /api/stats edge cache is purged on success.
 */
import type { JobStatusResult, JobStatusSnapshot, BucketKey } from '../../../../shared/types'
import { STAGE_ORDER, reachableStages, nextStage, stageRank, statusMoves } from '../../../../shared/pipeline'
import { getCloudflareEnv, resolveStaleDays, classify, readTitle, readRichText } from '../../../utils/notion'
import { POSITION_PROP } from '../../../utils/config'
import { jobFromPage } from '../../../utils/aggregate'
import { readApplication, snapshotOf, updateJobStatus, earliestReply, localDate } from '../../../utils/applications-notion'
import { purgeStats } from '../../../utils/stats-cache'
import { recordActivity, cancelLatestActivity } from '../../../utils/activity'

const STATUSES = new Set(['Applied', 'Interviewing', 'On Hold', 'Offer', 'Accepted', 'Offer Declined', 'Rejected'])
const ACTIONS = ['reject', 'advance', 'hold', 'accept', 'decline', 'reopen', 'restore']
const NEXT_ACTIONS = new Set(['Follow up', 'Waiting', 'Prepare Interview', 'Send email', 'Decide', 'Nothing'])

const bad = (statusMessage: string) => createError({ statusCode: 400, statusMessage })

function restoreSnapshot(raw: any): JobStatusSnapshot {
  if (!raw || typeof raw !== 'object') throw bad('Undo needs the previous state.')
  const status = raw.status ?? null
  const stage = raw.stage ?? null
  const nextAction = raw.nextAction ?? null
  if (status !== null && !STATUSES.has(status)) throw bad(`Unknown status "${status}".`)
  if (stage !== null && stageRank(stage) < 0) throw bad(`Unknown stage "${stage}".`)
  if (nextAction !== null && !NEXT_ACTIONS.has(nextAction)) throw bad(`Unknown next action "${nextAction}".`)
  const snap: JobStatusSnapshot = { status, stage, nextAction, interviewed: !!raw.interviewed }
  if ('replied' in raw) {
    if (raw.replied !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(raw.replied))) throw bad('replied must be YYYY-MM-DD or null.')
    snap.replied = raw.replied
  }
  return snap
}

export default defineEventHandler(async (event): Promise<JobStatusResult> => {
  const env = getCloudflareEnv(event)
  const id = String(getRouterParam(event, 'id') ?? '').replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(id)) throw bad('Not a Notion page id.')

  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const action = body.action
  if (!ACTIONS.includes(action)) throw bad(`action must be one of ${ACTIONS.join(', ')}.`)

  let page
  try {
    page = await readApplication(env, id)
  } catch (err: any) {
    throw createError({ statusCode: err?.statusCode ?? 502, statusMessage: String(err?.message || err).slice(0, 300) })
  }
  const previous = snapshotOf(page)
  const staleMs = resolveStaleDays(env) * 86_400_000
  const now = Date.now()

  let next: JobStatusSnapshot
  if (action === 'reject') {
    // Marking a row off Applied is the moment he saw a reply, unless an
    // earlier date is already known (usually the email's, from the Mac).
    next = { ...previous, status: 'Rejected', nextAction: 'Nothing', replied: earliestReply(previous.replied, localDate()) }
  } else if (action === 'advance') {
    const bucket = classify(page, { staleMs, now })
    const interviewing = bucket === 'interviewed' || bucket === 'progressing'
    const allowed = reachableStages(previous.stage, interviewing, bucket === 'offerAccepted')
    const stage = body.stage ?? nextStage(previous.stage)
    if (!STAGE_ORDER.includes(stage)) throw bad(`Unknown stage "${stage}".`)
    if (!allowed.includes(stage)) {
      // Two different refusals, and the message should say which: asking for
      // the rung it is already on is not "moving backwards".
      const repeat = stageRank(stage) === stageRank(previous.stage)
      throw createError({
        statusCode: 409,
        statusMessage: repeat
          ? `${stage} is already its furthest stage.`
          : `It already reached ${previous.stage} — ${stage} would move it backwards. Use Undo to go back.`,
      })
    }
    const offer = stage === 'Offer'
    next = {
      status: offer ? 'Offer' : 'Interviewing',
      stage,
      interviewed: true,
      nextAction: offer ? 'Decide' : 'Prepare Interview',
      replied: earliestReply(previous.replied, localDate()),
    }
  } else if (action === 'restore') {
    next = restoreSnapshot(body.previous)
  } else {
    // The four moves the menu offers besides reject and advance. Checked
    // against the same statusMoves() the menu was built from, so a stale menu
    // (the row changed in Notion since the page loaded) gets a plain refusal
    // instead of an odd write.
    const bucket = classify(page, { staleMs, now })
    const moves = statusMoves({ bucket: bucket ?? 'awaiting', stage: previous.stage, status: previous.status })
    if (!moves[action as 'hold' | 'accept' | 'decline' | 'reopen']) {
      throw createError({ statusCode: 409, statusMessage: `That no longer applies: this application is ${previous.status ?? 'in an unknown state'} now.` })
    }
    const today = earliestReply(previous.replied, localDate())
    if (action === 'hold') {
      next = { ...previous, status: 'On Hold', nextAction: 'Waiting', replied: today }
    } else if (action === 'accept' || action === 'decline') {
      next = { status: action === 'accept' ? 'Accepted' : 'Offer Declined', stage: 'Offer', interviewed: true, nextAction: 'Nothing', replied: today }
    } else {
      next = previous.stage
        ? { ...previous, status: 'Interviewing', nextAction: 'Prepare Interview' }
        : { ...previous, status: 'Applied', nextAction: 'Waiting', replied: previous.status === 'Rejected' ? null : previous.replied }
    }
  }

  let updated
  try {
    updated = await updateJobStatus(env, page, next)
  } catch (err: any) {
    throw createError({ statusCode: 502, statusMessage: String(err?.message || err).slice(0, 300) })
  }

  purgeStats(event)

  // What the EI day sees. Best effort: a missed event costs one suggested row
  // on the EI page, and must not turn a change Notion already accepted into an
  // error on the card.
  if (env.POSTINGS) {
    const kv = env.POSTINGS
    // Reopening is a correction, not correspondence he processed, so it leaves
    // no EI event; like Undo, it takes back the one it is correcting.
    const note = action === 'restore' || action === 'reopen'
      ? cancelLatestActivity(kv, id)
      : recordActivity(kv, {
          pageId: id,
          company: readTitle(updated) || 'an employer',
          position: readRichText(updated, POSITION_PROP),
          action,
          stage: next.stage,
        })
    const cfCtx = (event.context as any)?.cloudflare?.context
    const safe = note.catch(() => {})
    if (typeof cfCtx?.waitUntil === 'function') cfCtx.waitUntil(safe)
    else await safe
  }

  // Rebuild from what Notion says the row now is, not from what we asked for:
  // if it silently ignored a property, the card should show that, not a guess.
  const bucket = (classify(updated, { staleMs, now }) ?? 'awaiting') as BucketKey
  return { job: jobFromPage(updated, bucket, now), previous, current: snapshotOf(updated) }
})

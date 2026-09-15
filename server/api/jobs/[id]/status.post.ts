/**
 * POST /api/jobs/:id/status — mark an application rejected, or moved on a round.
 *
 * Body: { action: 'reject' }
 *     | { action: 'advance', stage?: 'Round 1 — Screen' | 'Round 2' | 'Round 3+' | 'Offer' }
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
 *   restore  exactly the snapshot given — the only way a stage goes back down
 *
 * Returns the row rebuilt the way the board builds it, plus what was there
 * before, so the page can move the card at once and offer Undo without a
 * second round trip. The /api/stats edge cache is purged on success.
 */
import type { JobStatusResult, JobStatusSnapshot, BucketKey } from '../../../../shared/types'
import { STAGE_ORDER, reachableStages, nextStage, stageRank } from '../../../../shared/pipeline'
import { getCloudflareEnv, resolveStaleDays, classify } from '../../../utils/notion'
import { jobFromPage } from '../../../utils/aggregate'
import { readApplication, snapshotOf, updateJobStatus } from '../../../utils/applications-notion'
import { purgeStats } from '../../../utils/stats-cache'

const STATUSES = new Set(['Applied', 'Interviewing', 'On Hold', 'Offer', 'Accepted', 'Rejected'])
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
  return { status, stage, nextAction, interviewed: !!raw.interviewed }
}

export default defineEventHandler(async (event): Promise<JobStatusResult> => {
  const env = getCloudflareEnv(event)
  const id = String(getRouterParam(event, 'id') ?? '').replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(id)) throw bad('Not a Notion page id.')

  const body = (await readBody(event).catch(() => ({}))) ?? {}
  const action = body.action
  if (!['reject', 'advance', 'restore'].includes(action)) throw bad('action must be reject, advance or restore.')

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
    next = { ...previous, status: 'Rejected', nextAction: 'Nothing' }
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
    }
  } else {
    next = restoreSnapshot(body.previous)
  }

  let updated
  try {
    updated = await updateJobStatus(env, page, next)
  } catch (err: any) {
    throw createError({ statusCode: 502, statusMessage: String(err?.message || err).slice(0, 300) })
  }

  purgeStats(event)

  // Rebuild from what Notion says the row now is, not from what we asked for:
  // if it silently ignored a property, the card should show that, not a guess.
  const bucket = (classify(updated, { staleMs, now }) ?? 'awaiting') as BucketKey
  return { job: jobFromPage(updated, bucket, now), previous, current: snapshotOf(updated) }
})

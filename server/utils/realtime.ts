/**
 * realtime.ts — the one way API routes announce that something changed.
 *
 * Routes call `announce(event, 'pack.done', { jobId, ... })` after they have
 * written their state. That reaches PipelineHub (a Durable Object) over RPC,
 * which fans it out to every open WebSocket: Lucas's phone, his laptop, and
 * the Mac workers.
 *
 * DESIGN RULE: announcing must never be able to fail a request. A broadcast is
 * a courtesy on top of state that is already persisted in KV — if the DO
 * binding is missing (local dev, a preview deploy, a partial rollout) or the
 * RPC throws, the route still returns 200 and the UI still gets the truth on
 * its next poll. Every call here is therefore fire-and-forget and swallows its
 * own errors. Nothing downstream should ever `await` a broadcast for
 * correctness.
 */
import type { H3Event } from 'h3'
import { getCloudflareEnv } from './notion'
import type { PipelineEventName } from '../durable/pipeline-hub'

/** Same instance name everywhere — one hub for one pipeline. */
const HUB_NAME = 'lucas'

interface HubStub {
  publish(evt: { event: string; id?: string; data?: Record<string, unknown>; at: string }): Promise<{ delivered: number }>
  command(cmd: { command: string; jobId?: string; id?: string }): Promise<{ delivered: number }>
  stats(): Promise<{ ui: number; worker: number }>
}

function hub(event: H3Event): HubStub | null {
  try {
    const env = getCloudflareEnv(event) as Record<string, any>
    const ns = env?.PIPELINE_HUB
    if (!ns?.getByName) return null
    return ns.getByName(HUB_NAME) as HubStub
  } catch {
    return null
  }
}

/**
 * Fire-and-forget broadcast. Safe to call from any route, in any environment.
 *
 * @param id  the posting id or pack jobId the UI keys its rows on
 * @param data a SMALL display-ready payload — status, company, timestamps.
 *             Never the whole posting: this crosses a WebSocket to a phone.
 */
export function announce(
  event: H3Event,
  name: PipelineEventName,
  id?: string,
  data?: Record<string, unknown>,
): void {
  const stub = hub(event)
  if (!stub) return
  const payload = { event: name, id, data, at: new Date().toISOString() }
  // Deliberately not awaited. `waitUntil` where available so the isolate is
  // not torn down mid-send, but never blocking the response.
  const p = stub.publish(payload).catch(() => { /* realtime is best-effort */ })
  const ctx = (event.context as any)?.cloudflare?.context
  if (ctx?.waitUntil) ctx.waitUntil(p)
}

/**
 * Push a command to the Mac workers only.
 *
 * This is the half that removes the wait. site-apply-worker.mjs polls
 * /api/packs/queue every 20 minutes; with this, tapping "Build pack" reaches
 * it in about a second. Polling stays in place as the fallback for when the
 * Mac is asleep or the socket has dropped — this makes it fast, it does not
 * make it load-bearing.
 */
export function commandWorkers(
  event: H3Event,
  command: 'build-pack' | 'evaluate' | 'refresh',
  ids: { jobId?: string; id?: string } = {},
): void {
  const stub = hub(event)
  if (!stub) return
  const p = stub.command({ command, ...ids }).catch(() => { /* best-effort */ })
  const ctx = (event.context as any)?.cloudflare?.context
  if (ctx?.waitUntil) ctx.waitUntil(p)
}

/** Connected-client counts, for a health endpoint or a debug badge. */
export async function realtimeStats(event: H3Event): Promise<{ ui: number; worker: number } | null> {
  const stub = hub(event)
  if (!stub) return null
  try { return await stub.stats() } catch { return null }
}

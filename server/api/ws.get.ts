/**
 * GET /api/ws — WebSocket upgrade into PipelineHub.
 *
 * Cloudflare Access gates this like every other route (see pack-route.ts), so
 * there is no auth code here: the browser arrives with an Access session and
 * the Mac workers arrive with a service token.
 *
 * ?role=worker  — a Mac worker. Gets commands (build-pack) as well as events.
 * ?role=ui      — default. A browser. Gets events only.
 *
 * The Upgrade header is checked BEFORE touching the Durable Object, because a
 * plain GET that reaches a DO is billed for nothing.
 */
import { getCloudflareEnv } from '../utils/notion'

export default defineEventHandler(async (event) => {
  const req = event.node.req
  const upgrade = (getRequestHeader(event, 'upgrade') || '').toLowerCase()
  if (upgrade !== 'websocket') {
    throw createError({
      statusCode: 426,
      statusMessage: 'This endpoint speaks WebSocket. Connect with ws:// or wss://.',
    })
  }

  const env = getCloudflareEnv(event) as Record<string, any>
  const ns = env?.PIPELINE_HUB
  if (!ns?.getByName) {
    // Local dev without the DO binding, or a deploy that predates the
    // migration. The UI treats this as "realtime unavailable" and falls back
    // to polling rather than breaking.
    throw createError({ statusCode: 503, statusMessage: 'Realtime not configured (no PIPELINE_HUB binding).' })
  }

  const role = getQuery(event).role === 'worker' ? 'worker' : 'ui'
  const stub = ns.getByName('lucas')

  // Hand the original request through so the DO can complete the 101 upgrade.
  const url = new URL(getRequestURL(event))
  url.searchParams.set('role', role)
  const raw = (event.context as any)?.cloudflare?.request ?? new Request(url.toString(), { headers: req.headers as any })

  return stub.fetch(new Request(url.toString(), raw))
})

import { DurableObject } from 'cloudflare:workers'

/**
 * PipelineHub — the realtime spine for jobs.codertheory.dev.
 *
 * WHY A DURABLE OBJECT AT ALL
 * The site is a Cloudflare Worker (see wrangler.toml, preset cloudflare_module).
 * Workers are stateless and short-lived, so they cannot hold a WebSocket open.
 * Durable Objects are the only primitive on Workers that can. There is no
 * lighter option that gives bi-directional push.
 *
 * WHY A SINGLE INSTANCE
 * The usual DO rule is one instance per coordination atom, never one global
 * object, because a global one is a bottleneck. That rule is about fan-out
 * scale, and here the coordination atom genuinely IS "Lucas's pipeline":
 * one user, a handful of clients (phone, laptop, and the Mac workers), and
 * every event has to reach all of them. A per-posting DO would fragment the
 * very broadcast this exists to do. If this ever became multi-user, the split
 * is per-user — `getByName(userId)` — and nothing else here changes.
 *
 * HIBERNATION
 * Connections are accepted with `ctx.acceptWebSocket()` rather than
 * `ws.accept()`, so the DO can be evicted from memory while the sockets stay
 * open. That matters a lot here: these are long-lived, very low-traffic
 * connections (a Mac worker idling all day, a phone left on a tab). Without
 * hibernation you pay for wall-clock duration on an object that is doing
 * nothing. Per-connection identity therefore lives in `serializeAttachment`,
 * not in instance fields, because instance fields do not survive eviction.
 *
 * TWO KINDS OF CLIENT
 *   role: "ui"     — a browser. Receives events, sends nothing important.
 *   role: "worker" — a Mac worker (site-apply-worker / site-eval-worker).
 *                    Receives commands so it can act the moment Lucas taps
 *                    "Build pack", instead of waiting up to 20 minutes for
 *                    its next poll. Polling stays as the fallback.
 */

export interface Env {
  PIPELINE_HUB: DurableObjectNamespace<PipelineHub>
  CAREER_OPS_SITE_CLIENT_SECRET?: string
}

/** Everything the pipeline can announce. Keep this list closed and explicit. */
export type PipelineEventName =
  | 'pack.requested'
  | 'pack.building'
  | 'pack.done'
  | 'pack.failed'
  | 'posting.created'
  | 'posting.updated'
  | 'posting.evaluated'
  | 'posting.state'
  | 'posting.applied'
  | 'posting.deleted'

export interface PipelineEvent {
  event: PipelineEventName
  /** Posting id or pack jobId — whatever the UI keys its rows on. */
  id?: string
  /** Small, display-ready payload. Never the full posting body. */
  data?: Record<string, unknown>
  at: string
}

const MAX_RECENT = 50

export class PipelineHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      // Schema setup only — this is the one place blockConcurrencyWhile belongs.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS recent (
          seq   INTEGER PRIMARY KEY AUTOINCREMENT,
          at    TEXT NOT NULL,
          event TEXT NOT NULL,
          body  TEXT NOT NULL
        )
      `)
    })
  }

  /**
   * Upgrade a request to a WebSocket. The Worker route has already checked the
   * Upgrade header and authenticated, so by here the connection is trusted.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const role = url.searchParams.get('role') === 'worker' ? 'worker' : 'ui'

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]

    // Hibernation-aware accept. Tag by role so we can address one side later.
    this.ctx.acceptWebSocket(server, [role])
    // Instance fields do not survive hibernation; the attachment does.
    server.serializeAttachment({ role, since: new Date().toISOString() })

    // Replay what happened while they were away, so a reconnecting phone is
    // immediately correct rather than correct-on-next-event.
    const backlog = this.ctx.storage.sql
      .exec<{ body: string }>('SELECT body FROM recent ORDER BY seq DESC LIMIT 15')
      .toArray()
      .reverse()
    for (const row of backlog) {
      try { server.send(row.body) } catch { /* client vanished mid-replay */ }
    }
    try {
      server.send(JSON.stringify({ event: 'hello', data: { role, clients: this.ctx.getWebSockets().length }, at: new Date().toISOString() }))
    } catch { /* ignore */ }

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * Called over RPC by the API routes whenever pipeline state changes.
   * Persist first, then fan out — a broadcast that fails must not lose the
   * event for a client that reconnects a second later.
   */
  async publish(evt: PipelineEvent): Promise<{ delivered: number }> {
    const at = evt.at ?? new Date().toISOString()
    const body = JSON.stringify({ ...evt, at })

    this.ctx.storage.sql.exec('INSERT INTO recent (at, event, body) VALUES (?, ?, ?)', at, evt.event, body)
    // Trim without a second round trip.
    this.ctx.storage.sql.exec(
      'DELETE FROM recent WHERE seq <= (SELECT MAX(seq) FROM recent) - ?',
      MAX_RECENT,
    )

    let delivered = 0
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(body); delivered++ } catch { /* dead socket, close handler cleans up */ }
    }
    return { delivered }
  }

  /**
   * Push a command to the Mac workers only. Used so "Build pack" reaches
   * site-apply-worker.mjs immediately instead of on its next 20-minute tick.
   */
  async command(cmd: { command: string; jobId?: string; id?: string }): Promise<{ delivered: number }> {
    const body = JSON.stringify({ ...cmd, at: new Date().toISOString() })
    let delivered = 0
    for (const ws of this.ctx.getWebSockets('worker')) {
      try { ws.send(body); delivered++ } catch { /* ignore */ }
    }
    return { delivered }
  }

  async stats(): Promise<{ ui: number; worker: number }> {
    return {
      ui: this.ctx.getWebSockets('ui').length,
      worker: this.ctx.getWebSockets('worker').length,
    }
  }

  // --- hibernation handlers -------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Clients are not trusted to publish. The only thing they may send is a
    // liveness ping; everything else is ignored on purpose. Broadcast happens
    // through publish(), which only the authenticated API routes can call.
    const text = typeof message === 'string' ? message : ''
    if (text === 'ping') {
      try { ws.send(JSON.stringify({ event: 'pong', at: new Date().toISOString() })) } catch { /* ignore */ }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code, reason) } catch { /* already gone */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, 'error') } catch { /* already gone */ }
  }
}

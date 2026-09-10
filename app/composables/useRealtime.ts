/**
 * useRealtime — one WebSocket for the whole app, shared across components.
 *
 * Connects to /api/ws (PipelineHub, a Durable Object) and turns pipeline
 * events into reactive state. The point is that the page reacts the moment
 * something happens on the Mac — a pack finishes building, a posting gets
 * evaluated, a row is marked applied — instead of on the next poll or reload.
 *
 * DESIGN RULES
 * - Realtime is an ACCELERANT, never the source of truth. Every consumer must
 *   still work if the socket never connects: refresh handlers re-fetch from the
 *   API. A dropped socket should degrade to "as fast as before", not "broken".
 * - One connection per tab, module-scoped. Components subscribe to it; they
 *   never open their own.
 * - Reconnect with backoff and jitter. A phone that has been asleep all night
 *   must not reconnect-storm the Worker on wake.
 * - The hub replays its recent buffer on connect, so a tab that missed events
 *   while backgrounded is correct immediately rather than on the next change.
 */
import { ref, shallowRef, onScopeDispose, type Ref } from 'vue'

export type PipelineEventName =
  | 'pack.requested' | 'pack.building' | 'pack.done' | 'pack.failed'
  | 'posting.created' | 'posting.updated' | 'posting.evaluated'
  | 'posting.state' | 'posting.applied' | 'posting.deleted'
  | 'hello' | 'pong'

export interface PipelineEvent {
  event: PipelineEventName
  id?: string
  data?: Record<string, any>
  at: string
}

type Handler = (evt: PipelineEvent) => void

let socket: WebSocket | null = null
let attempts = 0
let heartbeat: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const handlers = new Set<Handler>()

const status = ref<'idle' | 'connecting' | 'open' | 'closed'>('idle')
const lastEvent = shallowRef<PipelineEvent | null>(null)
const connectedAt = ref<string | null>(null)

function emit(evt: PipelineEvent) {
  lastEvent.value = evt
  for (const h of handlers) {
    try { h(evt) } catch { /* one bad subscriber must not break the rest */ }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  // Exponential backoff to 30s, with jitter so a phone waking on a flaky
  // connection does not sync up with every other retry.
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5))
  const delay = base + Math.floor(Math.random() * 1000)
  attempts++
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect() }, delay)
}

function connect() {
  if (typeof window === 'undefined') return          // SSR: never connect
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return

  status.value = 'connecting'
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  let ws: WebSocket
  try {
    ws = new WebSocket(`${proto}//${location.host}/api/ws?role=ui`)
  } catch {
    status.value = 'closed'
    scheduleReconnect()
    return
  }
  socket = ws

  ws.onopen = () => {
    status.value = 'open'
    connectedAt.value = new Date().toISOString()
    attempts = 0
    if (heartbeat) clearInterval(heartbeat)
    // Cloudflare drops idle sockets; a ping well inside that window keeps it.
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) { try { ws.send('ping') } catch { /* ignore */ } }
    }, 45_000)
  }

  ws.onmessage = (msg) => {
    let evt: PipelineEvent
    try { evt = JSON.parse(String(msg.data)) } catch { return }
    if (!evt?.event || evt.event === 'pong') return
    emit(evt)
  }

  ws.onclose = () => {
    status.value = 'closed'
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
    socket = null
    scheduleReconnect()
  }

  ws.onerror = () => { try { ws.close() } catch { /* onclose handles the rest */ } }
}

/**
 * @param onEvent  called for every pipeline event. Filter by `evt.event`.
 *                 Automatically unsubscribed when the calling scope is torn
 *                 down, so components never leak handlers.
 */
export function useRealtime(onEvent?: Handler): {
  status: Ref<'idle' | 'connecting' | 'open' | 'closed'>
  lastEvent: typeof lastEvent
  connectedAt: Ref<string | null>
} {
  connect()

  if (onEvent) {
    handlers.add(onEvent)
    onScopeDispose(() => { handlers.delete(onEvent) })
  }

  // A tab that was backgrounded may have had its socket closed silently.
  if (typeof document !== 'undefined' && !(window as any).__rtVisibility) {
    ;(window as any).__rtVisibility = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { attempts = 0; connect() }
    })
  }

  return { status, lastEvent, connectedAt }
}

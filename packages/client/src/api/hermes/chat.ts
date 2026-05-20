/**
 * Chat Run API (HTTP/SSE mode)
 *
 * Replaces the Socket.IO client with standard HTTP (fetch) + SSE (EventSource).
 * Event types, payloads, and handler signatures are preserved so stores don't need changes.
 */

import { getApiKey, getBaseUrlValue as getConfiguredBaseUrl } from '../client'

export interface ContentBlock {
  type: string
  text?: string
  source?: any
  [key: string]: any
}

export interface StartRunRequest {
  input: ContentBlock[] | string
  session_id?: string
  model?: string
  provider?: string
  model_groups?: Array<{ provider: string; models: string[] }>
  source?: string
  instructions?: string
  profile?: string
}

export interface RunEvent {
  event: string
  session_id?: string
  run_id?: string
  delta?: string
  text?: string
  tool_name?: string
  tool_input?: any
  tool_result?: any
  error?: string
  queue_length?: number
  queue_remaining?: number
  input_tokens?: number
  output_tokens?: number
  messages?: any[]
  working?: boolean
  [key: string]: any
}

// ─── State ────────────────────────────────────────────────────

interface SessionHandlers {
  onMessageDelta: (event: RunEvent) => void
  onReasoningDelta: (event: RunEvent) => void
  onThinkingDelta: (event: RunEvent) => void
  onReasoningAvailable: (event: RunEvent) => void
  onToolStarted: (event: RunEvent) => void
  onToolCompleted: (event: RunEvent) => void
  onRunStarted: (event: RunEvent) => void
  onRunCompleted: (event: RunEvent) => void
  onRunFailed: (event: RunEvent) => void
  onCompressionStarted: (event: RunEvent) => void
  onCompressionCompleted: (event: RunEvent) => void
  onAbortStarted: (event: RunEvent) => void
  onAbortCompleted: (event: RunEvent) => void
  onUsageUpdated: (event: RunEvent) => void
  onSessionCommand?: (event: RunEvent) => void
  onRunQueued?: (event: RunEvent) => void
  onApprovalRequested?: (event: RunEvent) => void
  onApprovalResolved?: (event: RunEvent) => void
}

const sessionEventHandlers = new Map<string, SessionHandlers>()
let globalEventSource: EventSource | null = null
let globalListenersRegistered = false

// ─── URL builders ────────────────────────────────────────────

function getBaseUrlValue(): string {
  try {
    return getConfiguredBaseUrl()
  } catch {
    return ''
  }
}

function sseUrl(sessionId?: string): string {
  const base = getBaseUrlValue()
  const token = getApiKey()
  const params = new URLSearchParams()
  if (sessionId) params.set('session_id', sessionId)
  if (token) params.set('token', token)
  // Get active profile
  let profile = 'default'
  try {
    const { useProfilesStore } = require('@/stores/hermes/profiles')
    profile = useProfilesStore().activeProfileName || 'default'
  } catch {
    profile = localStorage.getItem('hermes_active_profile_name') || 'default'
  }
  params.set('profile', profile)
  return `${base}/api/hermes/chat-run/events?${params.toString()}`
}

function apiUrl(path: string): string {
  const base = getBaseUrlValue()
  const token = getApiKey()
  const sep = path.includes('?') ? '&' : '?'
  return `${base}${path}${sep}token=${encodeURIComponent(token)}`
}

// ─── Global Event Handlers ───────────────────────────────────

function dispatchEvent(eventName: string, data: RunEvent): void {
  const sid = data.session_id
  if (!sid) return
  const handlers = sessionEventHandlers.get(sid)
  if (!handlers) return

  // Tag the event name into the payload
  data.event = eventName

  switch (eventName) {
    case 'message.delta': handlers.onMessageDelta(data); break
    case 'reasoning.delta': handlers.onReasoningDelta(data); break
    case 'thinking.delta': handlers.onThinkingDelta(data); break
    case 'reasoning.available': handlers.onReasoningAvailable(data); break
    case 'tool.started': handlers.onToolStarted(data); break
    case 'tool.completed': handlers.onToolCompleted(data); break
    case 'run.started': handlers.onRunStarted(data); break
    case 'run.completed':
      handlers.onRunCompleted(data)
      if ((data as any).queue_remaining > 0) return
      sessionEventHandlers.delete(sid)
      break
    case 'run.failed':
      handlers.onRunFailed(data)
      if ((data as any).queue_remaining > 0) return
      sessionEventHandlers.delete(sid)
      break
    case 'run.queued': handlers.onRunQueued?.(data); break
    case 'compression.started': handlers.onCompressionStarted(data); break
    case 'compression.completed': handlers.onCompressionCompleted(data); break
    case 'abort.started': handlers.onAbortStarted(data); break
    case 'abort.completed':
      handlers.onAbortCompleted(data)
      if ((data as any).queue_length > 0) return
      sessionEventHandlers.delete(sid)
      break
    case 'usage.updated': handlers.onUsageUpdated(data); break
    case 'session.command': handlers.onSessionCommand?.(data); break
    case 'approval.requested': handlers.onApprovalRequested?.(data); break
    case 'approval.resolved': handlers.onApprovalResolved?.(data); break
  }
}

function setupGlobalEventSource(sessionId?: string): EventSource {
  // If a sessionId is provided, always create a fresh EventSource (the session
  // determines which events we need; reusing a source without the session_id
  // means the server returns 400 and the client never receives events).
  if (sessionId) {
    if (globalEventSource && globalEventSource.readyState !== EventSource.CLOSED) {
      // Check if the existing EventSource was already created with this session_id
      const existingUrl = (globalEventSource as any)._url
      if (existingUrl && existingUrl.includes(`session_id=${encodeURIComponent(sessionId)}`)) {
        return globalEventSource
      }
      globalEventSource.close()
    }
    globalEventSource = new EventSource(sseUrl(sessionId))
    ;(globalEventSource as any)._url = sseUrl(sessionId)
    globalListenersRegistered = false
    registerGlobalListeners()
    return globalEventSource
  }

  if (globalEventSource && globalEventSource.readyState !== EventSource.CLOSED) {
    return globalEventSource
  }

  // Clean up old source
  if (globalEventSource) {
    globalEventSource.close()
    globalListenersRegistered = false
  }

  globalEventSource = new EventSource(sseUrl())
  ;(globalEventSource as any)._url = sseUrl()
  registerGlobalListeners()
  return globalEventSource
}

function registerGlobalListeners(): void {
  if (!globalEventSource || globalListenersRegistered) return
    const events = [
      'message.delta', 'reasoning.delta', 'thinking.delta',
      'reasoning.available', 'tool.started', 'tool.completed',
      'run.started', 'run.completed', 'run.failed', 'run.queued',
      'compression.started', 'compression.completed',
      'abort.started', 'abort.completed',
      'usage.updated', 'session.command',
      'approval.requested', 'approval.resolved',
    ]

    for (const ev of events) {
      globalEventSource.addEventListener(ev, (e: MessageEvent) => {
        try {
          const data: RunEvent = JSON.parse(e.data)
          dispatchEvent(ev, data)
        } catch { /* ignore parse errors */ }
      })
    }

    // Connection events
    globalEventSource.addEventListener('connected', () => {
      console.log('[chat SSE] connected to chat-run stream')
    })

    globalEventSource.addEventListener('resumed', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        const sid = data.session_id
        if (sid && sessionEventHandlers.has(sid)) {
          // Find the session handler and resume
          // This data carries messages, isWorking, etc.
          dispatchEvent('resumed', data)
        }
      } catch { /* ignore */ }
    })

    globalEventSource.onerror = () => {
      console.warn('[chat SSE] connection error, will retry automatically')
    }

    globalListenersRegistered = true
}

// ─── Public API ──────────────────────────────────────────────

export function registerSessionHandlers(
  sessionId: string,
  handlers: SessionHandlers,
): () => void {
  sessionEventHandlers.set(sessionId, handlers)
  return () => {
    sessionEventHandlers.delete(sessionId)
  }
}

export function unregisterSessionHandlers(sessionId: string): void {
  sessionEventHandlers.delete(sessionId)
}

export async function respondToolApproval(
  sessionId: string,
  approvalId: string,
  choice: 'once' | 'session' | 'always' | 'deny',
): Promise<void> {
  await fetch(apiUrl('/api/hermes/chat-run/approval-respond'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      approval_id: approvalId,
      choice,
    }),
  })
}

/** Connect to SSE stream — for stores that need a reference. */
export function connectChatRun(): EventSource {
  return setupGlobalEventSource()
}

export function disconnectChatRun(): void {
  if (globalEventSource) {
    globalEventSource.close()
    globalEventSource = null
    globalListenersRegistered = false
    sessionEventHandlers.clear()
  }
}

/** Resume a session via SSE. Returns the EventSource for tracking. */
export function resumeSession(
  sessionId: string,
  onResumed: (data: {
    session_id: string
    messages: any[]
    isWorking: boolean
    isAborting?: boolean
    events: any[]
    inputTokens?: number
    outputTokens?: number
    queueLength?: number
  }) => void,
): EventSource {
  // Set up SSE for this session
  const es = setupGlobalEventSource(sessionId)

  const handler = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data)
      if (data.session_id === sessionId) {
        es.removeEventListener('resumed', handler)
        onResumed(data)
      }
    } catch { /* ignore */ }
  }
  es.addEventListener('resumed', handler)

  return es
}

export interface StartRunResult {
  abort: () => void
}

export function startRunViaSocket(
  body: StartRunRequest,
  onEvent: (event: RunEvent) => void,
  onDone: () => void,
  onError: (err: Error) => void,
  onStarted?: (runId: string) => void,
): StartRunResult {
  const sid = body.session_id
  if (!sid) {
    throw new Error('session_id is required for startRunViaSocket')
  }

  // Ensure global EventSource is connected for this session
  setupGlobalEventSource(sid)

  let closed = false

  // Define event handlers for this session
  const handlers: SessionHandlers = {
    onMessageDelta: (evt) => { if (!closed) onEvent(evt) },
    onReasoningDelta: (evt) => { if (!closed) onEvent(evt) },
    onThinkingDelta: (evt) => { if (!closed) onEvent(evt) },
    onReasoningAvailable: (evt) => { if (!closed) onEvent(evt) },
    onToolStarted: (evt) => { if (!closed) onEvent(evt) },
    onToolCompleted: (evt) => { if (!closed) onEvent(evt) },
    onRunStarted: (evt) => {
      if (closed) return
      onEvent(evt)
      onStarted?.(evt.run_id || '')
    },
    onRunCompleted: (evt) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).queue_remaining > 0) return
      closed = true
      onDone()
    },
    onRunFailed: (evt) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).queue_remaining > 0) return
      closed = true
      onError(new Error(evt.error || 'Run failed'))
    },
    onCompressionStarted: (evt) => { if (!closed) onEvent(evt) },
    onCompressionCompleted: (evt) => { if (!closed) onEvent(evt) },
    onAbortStarted: (evt) => { if (!closed) onEvent(evt) },
    onAbortCompleted: (evt) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).queue_length > 0) return
      closed = true
      onDone()
    },
    onUsageUpdated: (evt) => { if (!closed) onEvent(evt) },
    onSessionCommand: (evt) => {
      if (closed) return
      onEvent(evt)
      if ((evt as any).terminal === false) return
      closed = true
      sessionEventHandlers.delete(sid)
      onDone()
    },
    onRunQueued: (evt) => { if (!closed) onEvent(evt) },
    onApprovalRequested: (evt) => { if (!closed) onEvent(evt) },
    onApprovalResolved: (evt) => { if (!closed) onEvent(evt) },
  }

  // Register handlers in the global session map
  sessionEventHandlers.set(sid, handlers)

  // Start the run via HTTP POST
  fetch(apiUrl('/api/hermes/chat-run/run'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(err => {
    if (!closed) {
      onError(err instanceof Error ? err : new Error(String(err)))
    }
  })

  return {
    abort: async () => {
      if (closed) return
      closed = true
      try {
        await fetch(apiUrl('/api/hermes/chat-run/abort'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sid }),
        })
      } catch {
        // Silently ignore abort errors
      }
    },
  }
}

// For backward compatibility with stores that check socket presence
export function getChatRunSocket(): EventSource | null {
  return globalEventSource
}

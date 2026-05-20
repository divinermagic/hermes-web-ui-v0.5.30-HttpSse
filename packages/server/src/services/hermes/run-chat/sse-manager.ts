/**
 * SSE Stream Manager — replaces Socket.IO for chat-run events.
 *
 * Maintains a registry of active SSE connections per session.
 * When a run produces events, they are streamed to all connected clients
 * for that session via standard Server-Sent Events (text/event-stream).
 */

import type { Context } from 'koa'
import { PassThrough } from 'stream'
import { logger } from '../../logger'

// ─── SSE Connection Registry ──────────────────────────────────

interface SseClient {
  ctx: Context
  stream: PassThrough
}

const sessionClients = new Map<string, Set<SseClient>>()

/**
 * Register a new SSE client for a session.
 * Returns a cleanup function.
 */
export function addSseClient(sessionId: string, ctx: Context, stream: PassThrough): () => void {
  if (!sessionClients.has(sessionId)) {
    sessionClients.set(sessionId, new Set())
  }
  const clients = sessionClients.get(sessionId)!
  const client: SseClient = { ctx, stream }
  clients.add(client)

  logger.info('[sse-manager] client added for session %s (total: %d)', sessionId, clients.size)

  return () => {
    clients.delete(client)
    if (clients.size === 0) {
      sessionClients.delete(sessionId)
    }
    logger.info('[sse-manager] client removed for session %s (remaining: %d)', sessionId, clients.size)
  }
}

/**
 * Emit an SSE event to all connected clients for a session.
 * Falls back to sending to the request-specific client if no session clients exist.
 */
export function emitToSession(
  sessionId: string,
  event: string,
  payload: any,
  fallbackCtx?: Context,
  fallbackStream?: PassThrough,
): void {
  const tagged = { ...payload, session_id: sessionId }
  const data = JSON.stringify(tagged)

  const clients = sessionClients.get(sessionId)
  if (clients && clients.size > 0) {
    let written = 0
    for (const client of clients) {
      try {
        if (!client.stream.destroyed) {
          client.stream.write(`event: ${event}\ndata: ${data}\n\n`)
          written++
        }
      } catch (err) {
        logger.warn(err, '[sse-manager] failed to write to SSE client for session %s', sessionId)
      }
    }
    if (written === 0 && fallbackStream && !fallbackStream.destroyed) {
      fallbackStream.write(`event: ${event}\ndata: ${data}\n\n`)
    }
  } else if (fallbackStream && !fallbackStream.destroyed) {
    fallbackStream.write(`event: ${event}\ndata: ${data}\n\n`)
  }
}

/**
 * Close all SSE connections for a session.
 */
export function closeSessionSse(sessionId: string): void {
  const clients = sessionClients.get(sessionId)
  if (!clients) return
  for (const client of clients) {
    try {
      if (!client.stream.destroyed) client.stream.end()
    } catch { /* ignore */ }
  }
  sessionClients.delete(sessionId)
}

/**
 * Get the number of connected SSE clients for a session.
 */
export function getSessionClientCount(sessionId: string): number {
  return sessionClients.get(sessionId)?.size ?? 0
}

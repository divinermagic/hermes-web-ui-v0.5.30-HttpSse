/**
 * Kanban Events — SSE-based replacement for WebSocket kanban watch bridge.
 *
 * Clients connect via GET /api/hermes/kanban/events?board=X&token=Y
 * Events are streamed as text/event-stream with named events.
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { getToken } from '../../services/auth'
import { logger } from '../../services/logger'
import * as kanbanCli from '../../services/hermes/hermes-kanban'

export const kanbanEventsRoutes = new Router()

// ─── SSE Event Stream ────────────────────────────────────────

kanbanEventsRoutes.get('/api/hermes/kanban/events', async (ctx: Context) => {
  const authToken = await getToken()
  if (authToken) {
    const token = String(ctx.query.token || '').trim()
    if (token !== authToken) {
      ctx.status = 401
      ctx.body = { error: 'Unauthorized' }
      return
    }
  }

  let board: string
  try {
    board = kanbanCli.normalizeBoardSlug(String(ctx.query.board || ''))
  } catch {
    ctx.status = 400
    ctx.body = { error: 'Invalid board parameter' }
    return
  }

  const child = kanbanCli.watchEvents({ board, interval: 0.5 })
  const res = ctx.res

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  // Send connected event
  res.write(`event: connected\ndata: ${JSON.stringify({ type: 'connected', board })}\n\n`)

  let closed = false

  const closeChild = () => {
    if (closed) return
    closed = true
    if (!child.killed) child.kill()
  }

  const streamLines = (onLine: (line: string) => void) => {
    let buffer = ''
    return (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed) onLine(trimmed)
      }
    }
  }

  child.stdout?.on('data', streamLines((line) => {
    if (line.toLowerCase().startsWith('watching kanban events')) return
    res.write(`event: event\ndata: ${JSON.stringify({ type: 'event', board, line })}\n\n`)
  }))

  child.stderr?.on('data', streamLines((line) => {
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', board, message: line })}\n\n`)
  }))

  child.on('error', (err) => {
    logger.error(err, 'Hermes CLI: kanban watch failed')
    try { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', board, message: err.message })}\n\n`) } catch { /* ignore */ }
    if (!closed) { try { res.end() } catch { /* ignore */ } }
    closeChild()
  })

  child.on('exit', (code, signal) => {
    try { res.write(`event: stopped\ndata: ${JSON.stringify({ type: 'stopped', board, code, signal })}\n\n`) } catch { /* ignore */ }
    if (!closed) { try { res.end() } catch { /* ignore */ } }
    closeChild()
  })

  ctx.req.on('close', closeChild)
  ctx.req.on('error', closeChild)

  // Heartbeat
  const heartbeat = setInterval(() => {
    if (!closed) {
      try { res.write(': heartbeat\n\n') } catch { clearInterval(heartbeat); closeChild() }
    } else {
      clearInterval(heartbeat)
    }
  }, 30000)

  logger.info(`[Kanban SSE] client connected for board: ${board}`)
})

export default kanbanEventsRoutes

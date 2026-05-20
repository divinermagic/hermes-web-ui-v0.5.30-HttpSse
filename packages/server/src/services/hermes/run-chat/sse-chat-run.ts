/**
 * SseChatRun — HTTP/SSE replacement for Socket.IO ChatRunSocket.
 *
 * Provides REST endpoints for actions (run, abort, approve, cancel queued)
 * and SSE endpoint for streaming events back to the client.
 *
 * Business logic for running chats is delegated to the same handlers
 * (handleApiRun, handleBridgeRun, handleAbort, etc.) — only the transport
 * layer changes from Socket.IO emit() to SSE write().
 */

import Router from '@koa/router'
import type { RouterContext } from '@koa/router'
import { PassThrough } from 'stream'
import { logger } from '../../logger'
import { getToken } from '../../auth'
import { getSystemPrompt } from '../../../lib/llm-prompt'
import { getSession } from '../../../db/hermes/session-store'
import { getActiveProfileName, listProfileNamesFromDisk } from '../hermes-profile'
import { AgentBridgeClient } from '../agent-bridge'
import { handleApiRun, resolveRunSource, loadSessionStateFromDb } from './handle-api-run'
import { handleBridgeRun } from './handle-bridge-run'
import { handleAbort } from './abort'
import { getOrCreateSession } from './compression'
import { handleSessionCommand, parseSessionCommand } from './session-command'
import { addSseClient, emitToSession, closeSessionSse } from './sse-manager'
import type { ContentBlock, QueuedRun, SessionState } from './types'

export type { ContentBlock }

export class SseChatRun {
  private router: Router

  constructor() {
    this.router = createSseChatRunRouter()
  }

  /** Initialize the SSE chat-run routes on the app. */
  setupRoutes(app: any): void {
    app.use(this.router.routes())
    app.use(this.router.allowedMethods())
  }

  /** Get the underlying Koa Router for mounting. */
  getRouter(): Router {
    return this.router
  }

  /** Close all active streams and clean up. */
  close() {
    const closeFn = (this.router as any)._close as (() => void) | undefined
    if (closeFn) closeFn()
  }
}

export function createSseChatRunRouter(): Router {
  const router = new Router()
  const bridge = new AgentBridgeClient()
  const sessionMap = new Map<string, SessionState>()

  // ─── Auth middleware ──────────────────────────────────────

  async function authMiddleware(ctx: RouterContext, next: () => Promise<void>) {
    if (!process.env.AUTH_DISABLED || process.env.AUTH_DISABLED === '1') {
      await next()
      return
    }
    const serverToken = await getToken()
    if (!serverToken) {
      await next()
      return
    }
    const token = ctx.query.token as string
      || ctx.request.headers.authorization?.replace(/^Bearer\s+/i, '')
      || ''
    if (token !== serverToken) {
      ctx.status = 401
      ctx.body = { error: 'Authentication failed' }
      return
    }
    await next()
  }

  // ─── Profile helpers ─────────────────────────────────────

  function resolveRunProfile(sessionId?: string, requested?: string): string {
    const requestedProfile = typeof requested === 'string' ? requested.trim() : ''
    if (requestedProfile && listProfileNamesFromDisk().includes(requestedProfile)) return requestedProfile
    if (!sessionId) return getActiveProfileName() || 'default'
    const storedProfile = getSession(sessionId)?.profile || ''
    return storedProfile && listProfileNamesFromDisk().includes(storedProfile)
      ? storedProfile
      : getActiveProfileName() || 'default'
  }

  function runQueuedItem(_ctx: RouterContext, sessionId: string, next: QueuedRun, fallbackProfile = 'default') {
    void handleRunInternal(
      {
        input: next.input,
        session_id: sessionId,
        model: next.model,
        provider: next.provider,
        model_groups: next.model_groups,
        instructions: next.instructions,
        source: next.source,
      },
      next.profile || fallbackProfile,
      true,
    ).catch(err => {
      logger.error(err, '[sse-chat-run] failed to run queued item for session %s', sessionId)
      emitToSession(sessionId, 'run.failed', {
        event: 'run.failed',
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  function dequeueNextQueuedRun(sessionId: string, fallbackProfile = 'default'): boolean {
    const state = sessionMap.get(sessionId)
    if (!state?.queue.length) return false

    const next = state.queue.shift()!
    logger.info('[sse-chat-run] dequeuing queued run for session %s (remaining: %d)', sessionId, state.queue.length)
    emitToSession(sessionId, 'run.queued', {
      event: 'run.queued',
      queue_length: state.queue.length,
    })
    runQueuedItem({} as any, sessionId, next, fallbackProfile)
    return true
  }

  // ─── Internal run handler ────────────────────────────────

  async function handleRunInternal(
    data: {
      input: string | ContentBlock[]
      session_id?: string
      model?: string
      provider?: string
      model_groups?: Array<{ provider: string; models: string[] }>
      instructions?: string
      source?: string
    },
    profile: string,
    skipUserMessage = false,
  ) {
    const source = resolveRunSource(data.source, data.session_id)

    if (data.session_id) {
      const state = getOrCreateSession(sessionMap, data.session_id)
      const command = parseSessionCommand(data.input)
      if (command && source === 'cli') {
        try {
          await handleSessionCommand(data.session_id, command, {
            nsp: null as any, // Not used with SSE
            socket: null as any,
            sessionMap,
            bridge,
            profile,
            model: data.model,
            instructions: data.instructions,
            runQueuedItem: (_s: any, sid: string, next: QueuedRun) => runQueuedItem({} as any, sid, next, profile),
          })
        } catch (err) {
          emitToSession(data.session_id, 'session.command', {
            event: 'session.command',
            command: command.rawName,
            ok: false,
            action: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
        }
        return
      }
    }

    if (source === 'cli') {
      let fullInstructions = data.instructions
        ? `${getSystemPrompt()}\n${data.instructions}`
        : getSystemPrompt()
      if (data.session_id) {
        const sessionRow = getSession(data.session_id)
        if (sessionRow?.workspace) {
          const workspaceCtx = `[Current working directory: ${sessionRow.workspace}]`
          fullInstructions = `\n${workspaceCtx}\n${fullInstructions}`
        }
      }

      await handleBridgeRun(
        null as any, // nsp not used
        null as any, // socket not used
        { ...data, instructions: fullInstructions },
        profile,
        sessionMap,
        bridge,
        skipUserMessage,
        loadSessionStateFromDb,
        (_s: any, sid: string, fallback?: string) => {
          dequeueNextQueuedRun(sid, fallback)
        },
      )
      return
    }

    await handleApiRun(
      null as any, // nsp not used
      null as any, // socket not used
      data,
      profile,
      sessionMap,
      skipUserMessage,
      (_s: any, sid: string, fallback?: string) => {
        dequeueNextQueuedRun(sid, fallback)
      },
    )
  }

  // ─── SSE Events endpoint ─────────────────────────────────

  router.get('/api/hermes/chat-run/events', authMiddleware, async (ctx) => {
    const sessionId = (ctx.query.session_id as string) || ''
    const profile = (ctx.query.profile as string) || 'default'
    const token = (ctx.query.token as string) || ''

    if (!sessionId) {
      ctx.status = 400
      ctx.body = { error: 'session_id query parameter is required' }
      return
    }

    // Set SSE headers
    ctx.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    ctx.status = 200

    const stream = new PassThrough()
    ctx.body = stream

    // Register this client
    const cleanup = addSseClient(sessionId, ctx, stream)

    // Send initial connected event
    stream.write(`event: connected\ndata: ${JSON.stringify({ session_id: sessionId, profile })}\n\n`)

    // Resume session state
    const state = sessionMap.get(sessionId)
      || await loadSessionStateFromDb(sessionId, sessionMap)
    if (!sessionMap.has(sessionId)) {
      sessionMap.set(sessionId, state)
    }

    stream.write(`event: resumed\ndata: ${JSON.stringify({
      session_id: sessionId,
      messages: state.messages,
      isWorking: state.isWorking,
      isAborting: state.isAborting || false,
      events: state.isWorking ? state.events : [],
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      queueLength: state.queue?.length || 0,
    })}\n\n`)

    logger.info('[sse-chat-run] SSE client connected for session %s', sessionId)

    // Handle disconnect
    ctx.req.on('close', () => {
      cleanup()
      logger.info('[sse-chat-run] SSE client disconnected for session %s', sessionId)
    })

    // Keep alive with heartbeat
    const heartbeat = setInterval(() => {
      if (!stream.destroyed) {
        stream.write(': heartbeat\n\n')
      }
    }, 15000)

    ctx.req.on('close', () => {
      clearInterval(heartbeat)
    })
  })

  // ─── Start Run endpoint ──────────────────────────────────

  router.post('/api/hermes/chat-run/run', authMiddleware, async (ctx) => {
    const body = ctx.request.body as {
      input: string | ContentBlock[]
      session_id?: string
      model?: string
      provider?: string
      model_groups?: Array<{ provider: string; models: string[] }>
      instructions?: string
      source?: string
      profile?: string
    }

    const runProfile = resolveRunProfile(body.session_id, body.profile)

    if (body.session_id) {
      const state = getOrCreateSession(sessionMap, body.session_id)
      const source = resolveRunSource(body.source, body.session_id)
      const command = parseSessionCommand(body.input)
      if (command && source === 'cli') {
        try {
          await handleSessionCommand(body.session_id, command, {
            nsp: null as any,
            socket: null as any,
            sessionMap,
            bridge,
            profile: runProfile,
            model: body.model,
            instructions: body.instructions,
            runQueuedItem: (_s: any, sid: string, next: QueuedRun) => runQueuedItem(ctx, sid, next, runProfile),
          })
          ctx.body = { status: 'command_handled' }
        } catch (err) {
          emitToSession(body.session_id, 'session.command', {
            event: 'session.command',
            command: command.rawName,
            ok: false,
            action: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
          ctx.body = { status: 'command_error' }
        }
        return
      }

      if (state.isWorking) {
        const queueId = `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
        state.queue.push({
          queue_id: queueId,
          input: body.input,
          model: body.model,
          provider: body.provider,
          model_groups: body.model_groups,
          instructions: body.instructions,
          profile: runProfile,
          source,
        })
        emitToSession(body.session_id, 'run.queued', {
          event: 'run.queued',
          queue_length: state.queue.length,
        })
        logger.info('[sse-chat-run] queued run for session %s (queue: %d)', body.session_id, state.queue.length)
        ctx.body = { status: 'queued', queue_id: queueId, queue_length: state.queue.length }
        return
      }

      state.isWorking = true
      state.profile = runProfile
      state.source = source
    }

    // Run asynchronously — respond immediately
    ctx.body = { status: 'started', session_id: body.session_id }

    try {
      await handleRunInternal(body, runProfile)
    } catch (err) {
      if (body.session_id) {
        const state = sessionMap.get(body.session_id)
        if (state && !state.runId && !state.abortController && !state.activeRunMarker) {
          state.isWorking = false
          state.profile = undefined
        }
      }
      emitToSession(body.session_id || '', 'run.failed', {
        event: 'run.failed',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // ─── Abort endpoint ──────────────────────────────────────

  router.post('/api/hermes/chat-run/abort', authMiddleware, async (ctx) => {
    const { session_id } = ctx.request.body as { session_id?: string }
    if (!session_id) {
      ctx.status = 400
      ctx.body = { error: 'session_id is required' }
      return
    }

    await handleAbort(
      null as any,
      null as any,
      session_id,
      sessionMap,
      bridge,
      (_s: any, sid: string, next: QueuedRun, fallback?: string) => runQueuedItem(ctx, sid, next, fallback || 'default'),
    )

    ctx.body = { status: 'abort_sent', session_id }
  })

  // ─── Cancel queued run endpoint ──────────────────────────

  router.post('/api/hermes/chat-run/cancel-queued', authMiddleware, async (ctx) => {
    const { session_id, queue_id } = ctx.request.body as { session_id?: string; queue_id?: string }
    if (!session_id || !queue_id) {
      ctx.status = 400
      ctx.body = { error: 'session_id and queue_id are required' }
      return
    }

    const state = sessionMap.get(session_id)
    if (!state?.queue.length) {
      ctx.body = { status: 'no_queue', session_id }
      return
    }

    const before = state.queue.length
    state.queue = state.queue.filter(item => item.queue_id !== queue_id)
    if (state.queue.length === before) {
      ctx.body = { status: 'not_found', session_id, queue_id }
      return
    }

    emitToSession(session_id, 'run.queued', {
      event: 'run.queued',
      queue_length: state.queue.length,
    })
    logger.info('[sse-chat-run] cancelled queued run %s for session %s (queue: %d)', queue_id, session_id, state.queue.length)

    ctx.body = { status: 'cancelled', session_id, queue_id, remaining: state.queue.length }
  })

  // ─── Approval respond endpoint ───────────────────────────

  router.post('/api/hermes/chat-run/approval-respond', authMiddleware, async (ctx) => {
    const { session_id, approval_id, choice } = ctx.request.body as {
      session_id?: string
      approval_id?: string
      choice?: string
    }

    if (!session_id || !approval_id) {
      ctx.status = 400
      ctx.body = { error: 'session_id and approval_id are required' }
      return
    }

    try {
      const result = await bridge.approvalRespond(approval_id, choice || 'deny')
      emitToSession(session_id, 'approval.resolved', {
        event: 'approval.resolved',
        approval_id,
        choice: choice || 'deny',
        resolved: Boolean(result.resolved),
      })
      ctx.body = { status: 'resolved', approval_id, resolved: Boolean(result.resolved) }
    } catch (err) {
      emitToSession(session_id, 'approval.resolved', {
        event: 'approval.resolved',
        approval_id,
        choice: choice || 'deny',
        resolved: false,
        error: err instanceof Error ? err.message : String(err),
      })
      ctx.body = {
        status: 'error',
        approval_id,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  // ─── Close ───────────────────────────────────────────────

  function close() {
    for (const [sessionId, state] of sessionMap.entries()) {
      if (state.abortController) {
        try {
          state.abortController.abort()
        } catch (e) {
          logger.warn(e, '[sse-chat-run] failed to abort controller for session %s', sessionId)
        }
      }
      closeSessionSse(sessionId)
    }
    sessionMap.clear()
    logger.info('[sse-chat-run] closed all connections and cleared state')
  }

  // Attach close method to the router for shutdown handling
  ;(router as any)._close = close

  logger.info('[sse-chat-run] HTTP/SSE chat run ready at /api/hermes/chat-run/*')
  return router
}

/**
 * SseGroupChatServer — SSE-based replacement for the Socket.IO GroupChatServer.
 *
 * Clients connect via GET /api/hermes/group-chat/events?roomId=X&userId=Y&name=Z
 * Actions are sent via REST POST endpoints.
 * Agents (AgentClients) call broadcastToRoom directly instead of using socket.io-client.
 */

import type { Context } from 'koa'
import { getToken } from '../../../services/auth'
import { logger } from '../../../services/logger'
import { AgentBridgeClient, type AgentBridgeOutput } from '../agent-bridge'
import { ContextEngine } from '../context-engine/compressor'
import { countTokens, SUMMARY_PREFIX } from '../../../lib/context-compressor'

// ─── Imports from the existing GroupChatServer (reuse ChatStorage) ───
import {
  ChatStorage,
  type PendingSessionDeleteDrainResult,
  drainPendingSessionDeletes,
} from './index'

// ─── Types ────────────────────────────────────────────────────

interface ChatMessage {
  id: string
  roomId: string
  senderId: string
  senderName: string
  content: string
  timestamp: number
  role?: string
  tool_call_id?: string | null
  tool_calls?: any[] | null
  tool_name?: string | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
  mentionDepth?: number
}

interface RoomAgent {
  id: string
  roomId: string
  agentId: string
  profile: string
  name: string
  description: string
  invited: number
}

interface Member {
  id: string
  userId: string
  name: string
  description: string
  joinedAt: number
  online: boolean
  connectionId: string
}

interface SseConnection {
  connectionId: string
  userId: string
  userName: string
  description: string
  roomId: string
  ctx: Context
  alive: boolean
  heartbeatTimer: ReturnType<typeof setInterval> | null
}

// ─── Helpers ──────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function contentToStorageString(content: unknown): string {
  if (typeof content === 'string') return content
  return JSON.stringify(content ?? '')
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try { return contentToText(JSON.parse(trimmed)) } catch { return content }
    }
    return content
  }
  if (Array.isArray(content)) {
    return content.map((block: any) => {
      if (block?.type === 'text') return block.text || ''
      if (block?.type === 'image') return `[Image: ${block.name || block.path || ''}]`
      if (block?.type === 'file') return `[File: ${block.name || block.path || ''}]`
      return ''
    }).filter(Boolean).join('\n')
  }
  return content == null ? '' : String(content)
}

function normalizeMessageRole(role: unknown): string {
  const value = String(role || '').trim()
  return ['user', 'assistant', 'tool', 'command'].includes(value) ? value : 'user'
}

function normalizeMentionDepth(depth: unknown): number {
  const value = Number(depth)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

// ─── ChatRoom (in-memory) ─────────────────────────────────────

class ChatRoom {
  readonly id: string
  name: string
  readonly members = new Map<string, Member>()

  constructor(id: string, name?: string) {
    this.id = id
    this.name = name || id
  }

  addOrUpdateMember(connectionId: string, userId: string, name: string, description: string): Member {
    const existing = this.members.get(userId)
    if (existing) {
      existing.name = name
      existing.description = description
      existing.online = true
      existing.connectionId = connectionId
      return existing
    }
    const member: Member = { id: connectionId, userId, name, description, joinedAt: Date.now(), online: true, connectionId }
    this.members.set(userId, member)
    return member
  }

  removeMember(connectionId: string): void {
    for (const member of this.members.values()) {
      if (member.connectionId === connectionId) {
        member.online = false
        break
      }
    }
  }

  getMembersList(): Member[] {
    return Array.from(this.members.values())
  }

  getOnlineMemberByConnectionId(connectionId: string): Member | undefined {
    for (const member of this.members.values()) {
      if (member.connectionId === connectionId && member.online) return member
    }
    return undefined
  }

  getOnlineMemberByUserId(userId: string): Member | undefined {
    const member = this.members.get(userId)
    return member?.online ? member : undefined
  }

  hasOnlineMember(connectionId: string): boolean {
    return this.getOnlineMemberByConnectionId(connectionId) !== undefined
  }
}

// ─── SSE Agent Client (replaces socket.io-client agents) ─────

interface AgentConfig {
  profile: string
  name: string
  description: string
  invited: number
}

interface AgentMentionMessage {
  id: string
  roomId: string
  content: string
  senderName: string
  senderId: string
  timestamp: number
  input?: string | any[]
  mentionDepth?: number
}

class SseAgentClient {
  readonly agentId: string
  readonly profile: string
  readonly name: string
  readonly description: string
  readonly invited: number
  private server: SseGroupChatServer
  private joinedRooms = new Set<string>()
  private contextEngine: ContextEngine | null = null
  private storage: ChatStorage

  constructor(config: AgentConfig, server: SseGroupChatServer) {
    this.agentId = generateId()
    this.profile = config.profile
    this.name = config.name
    this.description = config.description
    this.invited = config.invited
    this.server = server
    this.storage = server.getStorage()
  }

  setContextEngine(engine: ContextEngine): void {
    this.contextEngine = engine
  }

  joinRoom(roomId: string): void {
    this.joinedRooms.add(roomId)
  }

  removeRoom(roomId: string): void {
    this.joinedRooms.delete(roomId)
  }

  getJoinedRooms(): string[] {
    return Array.from(this.joinedRooms)
  }

  // Agente calling directly into server broadcast
  sendMessage(roomId: string, content: string, messageId?: string, extra?: Record<string, unknown>): void {
    const msg: ChatMessage = {
      id: messageId || generateId(),
      roomId,
      senderId: this.agentId,
      senderName: this.name,
      content: contentToStorageString(content),
      timestamp: Date.now(),
      role: extra?.role ? String(extra.role) : 'assistant',
      tool_call_id: extra?.tool_call_id as string | null ?? null,
      tool_calls: Array.isArray(extra?.tool_calls) ? extra.tool_calls as any[] : null,
      tool_name: extra?.tool_name as string | null ?? null,
      finish_reason: extra?.finish_reason as string | null ?? null,
      reasoning: extra?.reasoning as string | null ?? null,
    }
    try { this.storage.saveMessageAndRefreshRoom(msg) } catch (e) { logger.warn(e, '[SseAgent] save message failed') }
    this.server.broadcastToRoom(roomId, 'message', msg)
    this.server.broadcastToRoom(roomId, 'room_updated', { roomId, totalTokens: this.storage.getRoom(roomId)?.totalTokens ?? 0 })
  }

  startTyping(roomId: string): void {
    this.server.broadcastToRoom(roomId, 'typing', { roomId, userId: this.agentId, userName: this.name })
  }

  stopTyping(roomId: string): void {
    this.server.broadcastToRoom(roomId, 'stop_typing', { roomId, userId: this.agentId })
  }

  emitContextStatus(roomId: string, status: 'compressing' | 'replying' | 'ready'): void {
    this.server.broadcastToRoom(roomId, 'context_status', { roomId, agentName: this.name, status })
  }

  emitApprovalRequested(roomId: string, payload: Record<string, unknown>): void {
    this.server.broadcastToRoom(roomId, 'approval.requested', { event: 'approval.requested', roomId, agentName: this.name, ...payload })
  }

  emitApprovalResolved(roomId: string, payload: Record<string, unknown>): void {
    this.server.broadcastToRoom(roomId, 'approval.resolved', { event: 'approval.resolved', roomId, agentName: this.name, ...payload })
  }

  emitMessageStreamStart(roomId: string, messageId: string): void {
    this.server.broadcastToRoom(roomId, 'message_stream_start', {
      id: messageId, roomId, senderId: this.agentId, senderName: this.name,
      content: '', timestamp: Date.now(), role: 'assistant', finish_reason: 'streaming',
    })
  }

  emitMessageStreamDelta(roomId: string, messageId: string, delta: string): void {
    if (!delta) return
    this.server.broadcastToRoom(roomId, 'message_stream_delta', { roomId, id: messageId, delta })
  }

  emitMessageReasoningDelta(roomId: string, messageId: string, delta: string): void {
    if (!delta) return
    this.server.broadcastToRoom(roomId, 'message_reasoning_delta', { roomId, id: messageId, delta })
  }

  emitMessageStreamEnd(roomId: string, messageId: string): void {
    this.server.broadcastToRoom(roomId, 'message_stream_end', { roomId, id: messageId })
  }

  async interrupt(roomId: string): Promise<void> {
    const sessionSeed = String(this.storage.getRoom(roomId)?.sessionSeed || '0')
    const sessionId = `${roomId}_${this.profile}_${this.name}_${sessionSeed}`.replace(/[^a-zA-Z0-9_-]/g, '_')
    await new AgentBridgeClient().interrupt(sessionId, 'Interrupted by group chat user', this.profile)
    this.stopTyping(roomId)
    this.emitContextStatus(roomId, 'ready')
  }

  // Mention handling using AgentBridgeClient directly
  async replyToMention(
    roomId: string,
    msg: AgentMentionMessage,
    onStatus?: (status: 'compressing' | 'replying' | 'ready') => void,
  ): Promise<void> {
    logger.debug(`[SseAgent] ${this.name} mentioned by ${msg.senderName}: "${msg.content.slice(0, 50)}"`)
    try {
      this.startTyping(roomId)

      let instructions: string | undefined
      let conversationHistory: Array<{ role: string; content: string }> = []

      if (this.contextEngine) {
        try {
          onStatus?.('compressing')
          const roomMembers: Array<{ userId: string; name: string; description: string }> =
            this.storage.getRoomMembers(roomId) || []
          const roomInfo = this.storage.getRoom(roomId)
          const compression = roomInfo ? {
            triggerTokens: roomInfo.triggerTokens,
            maxHistoryTokens: roomInfo.maxHistoryTokens,
            tailMessageCount: roomInfo.tailMessageCount,
          } : undefined

          const ctx = await this.contextEngine.buildContext({
            roomId, agentId: this.agentId, agentName: this.name,
            agentDescription: this.description, agentSocketId: this.agentId,
            roomName: roomId,
            memberNames: roomMembers.map(m => m.name),
            members: roomMembers.map(m => ({ userId: m.userId, name: m.name, description: m.description })),
            upstream: '', apiKey: null,
            currentMessage: msg, compression, profile: this.profile,
          })
          conversationHistory = ctx.conversationHistory
          instructions = ctx.instructions
          onStatus?.('replying')
        } catch (err: any) {
          logger.warn(`[SseAgent] ${this.name}: context engine failed: ${err.message}`)
          onStatus?.('replying')
        }
      }

      const routedPrefix = `群聊系统：这条消息已经提及你（${this.name}），请直接回复；即使消息同时提及其他成员，也不要因此输出空回复。`
      const ownMentionPattern = new RegExp(`@${this.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'gi')
      const bridgeInput = `${routedPrefix}\n\n原始消息：${msg.content.replace(ownMentionPattern, '').trim() || msg.content}`

      const bridge = new AgentBridgeClient()
      const sessionSeed = String(this.storage.getRoom(roomId)?.sessionSeed || '0')
      const sessionId = `${roomId}_${this.profile}_${this.name}_${sessionSeed}`.replace(/[^a-zA-Z0-9_-]/g, '_')
      const runMessageId = `gc_${roomId}_${this.profile}_${generateId()}`
      let partIndex = 0
      let streamMessageId = `${runMessageId}_part_${partIndex}`
      let currentContent = ''
      let totalContent = ''
      let reasoningContent = ''

      const started = await bridge.chat(sessionId, bridgeInput, conversationHistory, instructions, this.profile, { source: 'api_server' })
      this.emitMessageStreamStart(roomId, streamMessageId)

      for await (const chunk of bridge.streamOutput(started.run_id, { timeoutMs: 120000 })) {
        reasoningContent += await this.recordBridgeEvents(roomId, chunk, () => streamMessageId, async () => {
          if (currentContent.trim()) {
            this.sendMessage(roomId, currentContent, streamMessageId, {
              role: 'assistant', mentionDepth: (msg.mentionDepth ?? 0) + 1,
              reasoning: reasoningContent || null, reasoning_content: reasoningContent || null,
            })
            currentContent = ''
          }
          this.emitMessageStreamEnd(roomId, streamMessageId)
          partIndex++
          streamMessageId = `${runMessageId}_part_${partIndex}`
          this.emitMessageStreamStart(roomId, streamMessageId)
          return streamMessageId
        })
        if (chunk.delta) {
          currentContent += chunk.delta
          totalContent += chunk.delta
          this.emitMessageStreamDelta(roomId, streamMessageId, chunk.delta)
        }
      }

      if (chunkForCheck?.status === 'error') {
        this.stopTyping(roomId)
        onStatus?.('ready')
        return
      }

      if (currentContent) {
        this.sendMessage(roomId, currentContent, streamMessageId, {
          role: 'assistant', mentionDepth: (msg.mentionDepth ?? 0) + 1,
          reasoning: reasoningContent || null, reasoning_content: reasoningContent || null,
        })
      }
      this.emitMessageStreamEnd(roomId, streamMessageId)
      this.stopTyping(roomId)
      onStatus?.('ready')
    } catch (err: any) {
      logger.error(`[SseAgent] ${this.name}: error handling mention: ${err.message}`)
      this.stopTyping(roomId)
      onStatus?.('ready')
    }
  }

  private async recordBridgeEvents(
    roomId: string,
    chunk: AgentBridgeOutput,
    getCurrentMessageId: () => string,
    beforeToolStarted: () => Promise<string>,
  ): Promise<string> {
    let reasoning = ''
    for (const ev of chunk.events || []) {
      const eventType = String((ev as any)?.event || '')
      if (eventType === 'approval.requested') {
        this.emitApprovalRequested(roomId, {
          event: 'approval.requested', approval_id: (ev as any).approval_id,
          command: (ev as any).command, description: (ev as any).description,
          choices: (ev as any).choices, allow_permanent: (ev as any).allow_permanent,
        })
      } else if (eventType === 'approval.resolved') {
        this.emitApprovalResolved(roomId, {
          event: 'approval.resolved', approval_id: (ev as any).approval_id,
          choice: (ev as any).choice,
        })
      } else if (eventType === 'reasoning.delta' || eventType === 'thinking.delta') {
        const text = String((ev as any)?.text || '')
        reasoning += text
        this.emitMessageReasoningDelta(roomId, getCurrentMessageId(), text)
      }
    }
    return reasoning
  }
}

// Variable used inside async loop for error detection
let chunkForCheck: AgentBridgeOutput | null = null

// ─── AgentClients Manager ─────────────────────────────────────

class SseAgentClients {
  private clients = new Map<string, SseAgentClient>()
  private server: SseGroupChatServer
  private contextEngine: ContextEngine | null = null

  constructor(server: SseGroupChatServer) {
    this.server = server
  }

  setContextEngine(engine: ContextEngine): void {
    this.contextEngine = engine
    for (const client of this.clients.values()) {
      client.setContextEngine(engine)
    }
  }

  async createAgent(config: AgentConfig): Promise<SseAgentClient> {
    const client = new SseAgentClient(config, this.server)
    if (this.contextEngine) client.setContextEngine(this.contextEngine)
    return client
  }

  async addAgentToRoom(roomId: string, client: SseAgentClient): Promise<void> {
    this.clients.set(client.agentId, client)
    client.joinRoom(roomId)
  }

  removeAgentFromRoom(roomId: string, agentId: string): void {
    const client = this.clients.get(agentId)
    if (client) client.removeRoom(roomId)
  }

  disconnectRoom(roomId: string): void {
    for (const client of this.clients.values()) {
      client.removeRoom(roomId)
    }
  }

  async interruptAgent(roomId: string, agentName: string): Promise<void> {
    for (const client of this.clients.values()) {
      if (client.name === agentName && client.getJoinedRooms().includes(roomId)) {
        await client.interrupt(roomId)
        return
      }
    }
  }

  getAgent(name: string): SseAgentClient | undefined {
    for (const client of this.clients.values()) {
      if (client.name === name) return client
    }
    return undefined
  }

  resetRoomContext(roomId: string): void {
    // No-op for now
  }

  async processMentions(roomId: string, msg: AgentMentionMessage): Promise<void> {
    const mentionPattern = /@(\S+?)(?:\s|$|,|，)/g
    const mentioned = new Set<string>()
    let match
    while ((match = mentionPattern.exec(msg.content)) !== null) {
      mentioned.add(match[1])
    }

    for (const client of this.clients.values()) {
      if (client.getJoinedRooms().includes(roomId) && mentioned.has(client.name)) {
        client.replyToMention(roomId, msg, (status) => {
          if (status === 'compressing') {
            this.server.broadcastToRoom(roomId, 'context_status', {
              roomId, agentName: client.name, status: 'compressing',
            })
          } else if (status === 'replying') {
            this.server.broadcastToRoom(roomId, 'context_status', {
              roomId, agentName: client.name, status: 'replying',
            })
          } else {
            this.server.broadcastToRoom(roomId, 'context_status', {
              roomId, agentName: client.name, status: 'ready',
            })
          }
        }).catch(err => logger.error(`[SseAgentClients] ${client.name}: ${err.message}`))
      }
    }
  }
}

// ─── SseGroupChatServer ───────────────────────────────────────

export class SseGroupChatServer {
  private storage: ChatStorage
  private rooms = new Map<string, ChatRoom>()
  /** connectionId → SseConnection */
  private connections = new Map<string, SseConnection>()
  /** userId → { name, description } */
  private userInfoMap = new Map<string, { name: string; description: string }>()
  /** roomId → (userId → { userName, timer }) */
  private typingState = new Map<string, Map<string, { userName: string; timer: ReturnType<typeof setTimeout> }>>()
  /** roomId → (agentName → { agentName, status }) */
  private contextStatusState = new Map<string, Map<string, { agentName: string; status: string }>>()
  readonly agentClients: SseAgentClients
  private contextEngine: ContextEngine | null = null
  private _restoreScheduled = false

  constructor() {
    this.storage = new ChatStorage()
    this.storage.init()
    this.agentClients = new SseAgentClients(this)

    // Restore persisted rooms into memory
    this.storage.getAllRooms().forEach((row: any) => {
      this.rooms.set(row.id, new ChatRoom(row.id, row.name))
    })

    // Init context engine
    const contextEngine = new ContextEngine({
      messageFetcher: this.storage as any,
      sessionCleaner: async (_sessionId: string) => {
        // No-op for now
      },
    })
    this.agentClients.setContextEngine(contextEngine)
    this.contextEngine = contextEngine

    logger.info('[SseGroupChat] SSE GroupChatServer initialized')
  }

  getStorage(): ChatStorage {
    return this.storage
  }

  getRoomIds(): string[] {
    return Array.from(this.rooms.keys())
  }

  // ─── SSE Connection Management ─────────────────────────────

  async handleEventsStream(ctx: Context): Promise<void> {
    const token = await getToken()
    if (token) {
      const clientToken = String(ctx.query?.token || '').trim()
      if (clientToken !== token) {
        ctx.status = 401
        ctx.body = { error: 'Unauthorized' }
        return
      }
    }

    const roomId = String(ctx.query?.roomId || 'general')
    const userId = String(ctx.query?.userId || generateId())
    const userName = String(ctx.query?.name || `User-${userId.slice(0, 6)}`)
    const description = String(ctx.query?.description || '')
    const existingConnectionId = String(ctx.query?.connectionId || '')

    // Store user info
    this.userInfoMap.set(userId, { name: userName, description })

    // Ensure room exists
    let room = this.rooms.get(roomId)
    if (!room) {
      room = new ChatRoom(roomId)
      this.rooms.set(roomId, room)
      this.storage.saveRoom(roomId, roomId)
    }

    // Set up SSE headers
    const res = ctx.res

    // Prevent Koa from handling the response — we manage the raw stream directly.
    // Without this, Koa's ctx.respond logic sees no ctx.body and ends the SSE
    // stream shortly after the middleware returns, causing EventSource errors
    // in the browser (reconnection loop every ~3 seconds).
    ctx.respond = false

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // Disable socket timeout so the SSE connection stays alive indefinitely.
    // Node.js default keepAliveTimeout is 5s which kills the connection before
    // the first heartbeat (was 30s). Combined with a 15s heartbeat below,
    // the connection survives proxy timeouts (nginx default 60s).
    const req = ctx.req
    if (req.socket) req.socket.setTimeout(0)

    const connectionId = existingConnectionId || generateId()

    // Reconnect cleanup: remove old connection for same userId in same room
    for (const [cid, conn] of this.connections) {
      if (conn.userId === userId && conn.roomId === roomId && cid !== connectionId) {
        this.cleanupConnection(cid)
      }
    }

    // Add member to room
    this.storage.addRoomMember(roomId, userId, userName, description)
    room.addOrUpdateMember(connectionId, userId, userName, description)

    // Create connection record
    const conn: SseConnection = {
      connectionId,
      userId,
      userName,
      description,
      roomId,
      ctx,
      alive: true,
      heartbeatTimer: setInterval(() => {
        if (conn.alive) {
          try { res.write(': heartbeat\n\n') } catch { /* ignore */ }
        }
      }, 15000),
    }
    this.connections.set(connectionId, conn)

    // Send initial connection confirmation
    this.sendSse(res, 'connected', { connectionId, roomId, userId, userName })

    // Send room state
    this.sendSse(res, 'member_joined', {
      roomId, memberId: userId, memberName: userName,
      members: room.getMembersList(),
    })

    const messages = this.storage.getMessages(roomId)
    const agents = this.storage.getRoomAgents(roomId)

    this.sendSse(res, 'joined', {
      roomId, roomName: room.name,
      members: room.getMembersList(),
      messages, agents,
      rooms: this.getRoomIds(),
      typingUsers: this.getTypingUsers(roomId),
      contextStatuses: this.getContextStatuses(roomId),
    })

    // Handle client disconnect
    ctx.req.on('close', () => {
      this.handleDisconnect(connectionId)
    })
    ctx.req.on('error', () => {
      this.handleDisconnect(connectionId)
    })

    logger.debug(`[SseGroupChat] ${userName} (user=${userId}) connected to room ${roomId} via SSE`)
  }

  private handleDisconnect(connectionId: string): void {
    const conn = this.connections.get(connectionId)
    if (!conn) return
    conn.alive = false
    if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer)

    const room = this.rooms.get(conn.roomId)
    const userName = conn.userName
    const userId = conn.userId

    // Clean up typing state
    for (const [, roomTyping] of this.typingState) {
      const entry = roomTyping.get(userId)
      if (entry) {
        clearTimeout(entry.timer)
        roomTyping.delete(userId)
      }
    }

    // Leave room
    if (room) {
      room.removeMember(connectionId)
      this.broadcastToRoom(conn.roomId, 'member_left', {
        roomId: conn.roomId,
        memberId: userId,
        memberName: userName,
        members: room.getMembersList(),
      })
    }

    this.connections.delete(connectionId)
    logger.debug(`[SseGroupChat] ${userName} (user=${userId}) disconnected from room ${conn.roomId}`)
  }

  private cleanupConnection(connectionId: string): void {
    const conn = this.connections.get(connectionId)
    if (!conn) return
    if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer)
    try { conn.ctx.res.end() } catch { /* ignore */ }
    this.connections.delete(connectionId)
  }

  // ─── SSE Broadcast ─────────────────────────────────────────

  broadcastToRoom(roomId: string, event: string, payload: any): void {
    const data = JSON.stringify(typeof payload === 'object' ? payload : { data: payload })
    const message = `event: ${event}\ndata: ${data}\n\n`

    for (const conn of this.connections.values()) {
      if (conn.alive && conn.roomId === roomId) {
        try {
          conn.ctx.res.write(message)
        } catch {
          this.handleDisconnect(conn.connectionId)
        }
      }
    }
  }

  private sendSse(res: any, event: string, payload: any): void {
    const data = JSON.stringify(typeof payload === 'object' ? payload : { data: payload })
    try {
      res.write(`event: ${event}\ndata: ${data}\n\n`)
    } catch { /* ignore */ }
  }

  // ─── REST Action Handlers ──────────────────────────────────

  async handleJoin(ctx: Context): Promise<void> {
    const { roomId, userId: reqUserId, name, description } = ctx.request.body as any || {}
    const token = await getToken()
    if (token) {
      const clientToken = String(ctx.headers['authorization'] || ctx.query?.token || '').replace('Bearer ', '')
      if (clientToken !== token) { ctx.status = 401; ctx.body = { error: 'Unauthorized' }; return }
    }

    const rid = roomId || 'general'
    const connectionId = String(ctx.request.body?.connectionId || ctx.query?.connectionId || generateId())
    const userId = reqUserId || connectionId

    let room = this.rooms.get(rid)
    if (!room) {
      room = new ChatRoom(rid)
      this.rooms.set(rid, room)
      this.storage.saveRoom(rid, rid)
    }

    const userName = name || `User-${userId.slice(0, 6)}`
    this.userInfoMap.set(userId, { name: userName, description: description || '' })
    this.storage.addRoomMember(rid, userId, userName, description || '')
    room.addOrUpdateMember(connectionId, userId, userName, description || '')

    // Move existing SSE connections for this user to the target room.
    // Without this, messages broadcast to the target room won't reach the
    // user's SSE connection (which stays on the original room from handleEventsStream).
    for (const [cid, conn] of this.connections) {
      if (conn.userId === userId && conn.alive && conn.roomId !== rid) {
        const oldRoom = conn.roomId
        conn.roomId = rid
        logger.debug(`[SseGroupChat] moved connection ${cid} for user ${userId} from ${oldRoom} to ${rid}`)
      }
    }

    const messages = this.storage.getMessages(rid)
    const agents = this.storage.getRoomAgents(rid)

    ctx.body = {
      roomId: rid, roomName: room.name,
      members: room.getMembersList(),
      messages, agents,
      rooms: this.getRoomIds(),
      typingUsers: this.getTypingUsers(rid),
      contextStatuses: this.getContextStatuses(rid),
    }
  }

  async handleMessage(ctx: Context): Promise<void> {
    const data = ctx.request.body as any || {}
    const token = await getToken()
    if (token) {
      const clientToken = String(ctx.headers['authorization'] || ctx.query?.token || '').replace('Bearer ', '')
      if (clientToken !== token) { ctx.status = 401; ctx.body = { error: 'Unauthorized' }; return }
    }

    const roomId = data.roomId || 'general'
    const room = this.rooms.get(roomId)
    const connectionId = String(data.connectionId || '')

    if (!room) {
      logger.warn(
        `[SseGroupChat] handleMessage blocked — roomId=${roomId} roomExists=false connectionsSize=${this.connections.size}`,
      )
      ctx.body = { error: 'Not in room' }; ctx.status = 400; return
    }

    // Determine sender identity — prefer connectionId lookup, fall back to userId
    let member = connectionId ? room.getOnlineMemberByConnectionId(connectionId) : undefined
    let userId = member?.userId || data.userId || connectionId
    let userName = member?.name || data.name || `User-${userId.slice(0, 6)}`

    // If the connectionId is stale (SSE reconnected), try to find the member by userId
    if (!member && data.userId) {
      const byUserId = room.getOnlineMemberByUserId(data.userId)
      if (byUserId) {
        member = byUserId
        userId = member.userId
        userName = member.name
        logger.debug(`[SseGroupChat] handleMessage: found member by userId=${data.userId} (connectionId was stale)`)
      }
    }

    // Only block if we truly can't identify the sender
    if (!member && connectionId && !data.userId) {
      logger.warn(
        `[SseGroupChat] handleMessage blocked — no member found for connectionId=${connectionId} or userId`,
      )
      ctx.body = { error: 'Not in room' }; ctx.status = 400; return
    }

    const msg: ChatMessage = {
      id: data.id || generateId(),
      roomId,
      senderId: userId,
      senderName: userName,
      content: contentToStorageString(data.content),
      timestamp: data.timestamp || Date.now(),
      role: normalizeMessageRole(data.role),
      tool_call_id: data.tool_call_id ?? null,
      tool_calls: Array.isArray(data.tool_calls) ? data.tool_calls : null,
      tool_name: data.tool_name ?? null,
      finish_reason: data.finish_reason ?? null,
      reasoning: data.reasoning ?? null,
      reasoning_details: data.reasoning_details ?? null,
      reasoning_content: data.reasoning_content ?? null,
    }

    const saved = this.storage.saveMessageAndRefreshRoom(msg)
    const savedMsg = saved.message
    const totalTokens = saved.totalTokens

    this.broadcastToRoom(roomId, 'message', savedMsg)
    this.broadcastToRoom(roomId, 'room_updated', { roomId, totalTokens })

    ctx.body = { id: savedMsg.id }

    const mentionDepth = normalizeMentionDepth(data.mentionDepth)
    const shouldRouteMentions =
      savedMsg.role === 'user' ||
      (savedMsg.role === 'assistant' && mentionDepth < 2)

    if (shouldRouteMentions) {
      this.agentClients.processMentions(roomId, {
        id: savedMsg.id,
        roomId,
        content: contentToText(savedMsg.content),
        senderName: savedMsg.senderName,
        senderId: savedMsg.senderId,
        timestamp: savedMsg.timestamp,
        mentionDepth,
      }).catch((err) => {
        logger.error(`[SseGroupChat] processMentions error: ${err.message}`)
      })
    }
  }

  async handleMessageStreamStart(ctx: Context): Promise<void> {
    const data = ctx.request.body as any || {}
    const roomId = data.roomId || 'general'
    this.broadcastToRoom(roomId, 'message_stream_start', {
      id: data.id || generateId(),
      roomId,
      senderId: data.senderId || '',
      senderName: data.senderName || '',
      content: '',
      timestamp: data.timestamp || Date.now(),
      role: 'assistant',
      finish_reason: 'streaming',
    })
    ctx.body = { ok: true }
  }

  async handleMessageStreamDelta(ctx: Context): Promise<void> {
    const data = ctx.request.body as any || {}
    const roomId = data.roomId || 'general'
    if (!data.delta) { ctx.body = { ok: true }; return }
    this.broadcastToRoom(roomId, 'message_stream_delta', { roomId, id: data.id, delta: String(data.delta) })
    ctx.body = { ok: true }
  }

  async handleMessageReasoningDelta(ctx: Context): Promise<void> {
    const data = ctx.request.body as any || {}
    const roomId = data.roomId || 'general'
    if (!data.delta) { ctx.body = { ok: true }; return }
    this.broadcastToRoom(roomId, 'message_reasoning_delta', { roomId, id: data.id, delta: String(data.delta) })
    ctx.body = { ok: true }
  }

  async handleMessageStreamEnd(ctx: Context): Promise<void> {
    const data = ctx.request.body as any || {}
    const roomId = data.roomId || 'general'
    this.broadcastToRoom(roomId, 'message_stream_end', { roomId, id: data.id })
    ctx.body = { ok: true }
  }

  async handleTyping(ctx: Context): Promise<void> {
    const data = ctx.request.body as any || {}
    const roomId = data.roomId || 'general'
    const userId = data.userId || ''
    const userName = data.userName || ''

    let roomTyping = this.typingState.get(roomId)
    if (!roomTyping) {
      roomTyping = new Map()
      this.typingState.set(roomId, roomTyping)
    }
    const existing = roomTyping.get(userId)
    if (existing) clearTimeout(existing.timer)
    roomTyping.set(userId, {
      userName,
      timer: setTimeout(() => {
        roomTyping?.delete(userId)
        if (roomTyping && roomTyping.size === 0) this.typingState.delete(roomId)
      }, 30000),
    })

    this.broadcastToRoom(roomId, 'typing', { roomId, userId, userName })
    ctx.body = { ok: true }
  }

  async handleStopTyping(ctx: Context): Promise<void> {
    const data = ctx.request.body as any || {}
    const roomId = data.roomId || 'general'
    const userId = data.userId || ''

    const roomTyping = this.typingState.get(roomId)
    if (roomTyping) {
      const entry = roomTyping.get(userId)
      if (entry) clearTimeout(entry.timer)
      roomTyping.delete(userId)
    }

    this.broadcastToRoom(roomId, 'stop_typing', { roomId, userId })
    ctx.body = { ok: true }
  }

  async handleContextStatus(ctx: Context): Promise<void> {
    const data = ctx.request.body as any || {}
    const roomId = data.roomId || 'general'
    const agentName = data.agentName || ''
    const status = data.status || ''

    if (!agentName) { ctx.body = { ok: true }; return }

    let roomStatuses = this.contextStatusState.get(roomId)
    if (!roomStatuses) {
      roomStatuses = new Map()
      this.contextStatusState.set(roomId, roomStatuses)
    }

    if (status === 'ready') {
      roomStatuses.delete(agentName)
    } else {
      roomStatuses.set(agentName, { agentName, status })
    }

    this.broadcastToRoom(roomId, 'context_status', { roomId, agentName, status })
    ctx.body = { ok: true }
  }

  async handleInterruptAgent(ctx: Context): Promise<void> {
    const data = ctx.request.body as any || {}
    const roomId = data.roomId
    const agentName = data.agentName

    if (!roomId || !agentName) { ctx.status = 400; ctx.body = { error: 'roomId and agentName required' }; return }

    try {
      await this.agentClients.interruptAgent(roomId, agentName)
      this.broadcastToRoom(roomId, 'context_status', { roomId, agentName, status: 'ready' })
      ctx.body = { ok: true }
    } catch (err: any) {
      ctx.status = 500
      ctx.body = { error: err.message }
    }
  }

  async handleApprovalRespond(ctx: Context): Promise<void> {
    const data = ctx.request.body as any || {}
    if (!data.approval_id) { ctx.status = 400; ctx.body = { error: 'approval_id required' }; return }

    try {
      const result = await new AgentBridgeClient().approvalRespond(data.approval_id, data.choice || 'deny')
      ctx.body = { ok: true, resolved: Boolean((result as any)?.resolved) }
    } catch (err: any) {
      ctx.status = 500
      ctx.body = { error: err.message }
    }
  }

  async handleClearRoomContext(ctx: Context, roomId: string): Promise<void> {
    if (!this.storage.getRoom(roomId)) { ctx.status = 404; ctx.body = { error: 'Room not found' }; return }

    const roomTyping = this.typingState.get(roomId)
    if (roomTyping) {
      for (const entry of roomTyping.values()) clearTimeout(entry.timer)
      this.typingState.delete(roomId)
    }
    this.contextStatusState.delete(roomId)
    this.agentClients.resetRoomContext(roomId)

    this.storage.clearRoomContext(roomId)
    this.broadcastToRoom(roomId, 'room_cleared', { roomId, totalTokens: 0 })
    this.broadcastToRoom(roomId, 'room_updated', { roomId, totalTokens: 0 })

    ctx.body = { success: true, room: this.storage.getRoom(roomId) }
  }

  // ─── Restore agents ────────────────────────────────────────

  async restoreWhenReady(): Promise<void> {
    if (this._restoreScheduled) return
    this._restoreScheduled = true
    await this.restoreAgents()
  }

  private async restoreAgents(): Promise<void> {
    const rooms = this.storage.getAllRooms()
    let total = 0
    for (const room of rooms) {
      const agents = this.storage.getRoomAgents(room.id)
      for (const agent of agents) {
        try {
          const client = await this.agentClients.createAgent({
            profile: agent.profile,
            name: agent.name,
            description: agent.description,
            invited: agent.invited,
          })
          await this.agentClients.addAgentToRoom(room.id, client)
          total++
        } catch (err: any) {
          logger.error(`[SseGroupChat] Failed to restore agent ${agent.name}: ${err.message}`)
        }
      }
    }
    if (total > 0) logger.info(`[SseGroupChat] Restored ${total} agent(s)`)
  }

  // ─── Helpers ───────────────────────────────────────────────

  private getTypingUsers(roomId: string): Array<{ userId: string; userName: string }> {
    const roomTyping = this.typingState.get(roomId)
    if (!roomTyping) return []
    return Array.from(roomTyping.entries()).map(([userId, entry]) => ({ userId, userName: entry.userName }))
  }

  private getContextStatuses(roomId: string): Array<{ agentName: string; status: string }> {
    const roomStatuses = this.contextStatusState.get(roomId)
    if (!roomStatuses) return []
    return Array.from(roomStatuses.values())
  }

  close(): void {
    for (const conn of this.connections.values()) {
      if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer)
      try { conn.ctx.res.end() } catch { /* ignore */ }
    }
    this.connections.clear()
    logger.info('[SseGroupChat] closed all SSE connections')
  }
}

// Export the class and types
export { ChatStorage }
export type { PendingSessionDeleteDrainResult }
export { drainPendingSessionDeletes }

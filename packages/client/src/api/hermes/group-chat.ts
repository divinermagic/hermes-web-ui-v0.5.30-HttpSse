/**
 * Group Chat API (HTTP/SSE mode)
 *
 * Replaces the Socket.IO client with standard HTTP (fetch) + SSE (EventSource).
 * REST API functions are preserved as-is.
 */

import { request, getApiKey } from '../client'

// ─── Types ──────────────────────────────────────────────────

export interface RoomInfo {
    id: string
    name: string
    inviteCode: string | null
    triggerTokens?: number
    maxHistoryTokens?: number
    tailMessageCount?: number
    totalTokens?: number
}

export interface RoomAgent {
    id: string
    roomId: string
    agentId: string
    profile: string
    name: string
    description: string
    invited: number
}

export interface ChatMessage {
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
    isStreaming?: boolean
    toolName?: string
    toolCallId?: string
    toolArgs?: string
    toolPreview?: string
    toolResult?: string
    toolStatus?: 'running' | 'done' | 'error'
    attachments?: Array<{ id: string; name: string; type: string; size: number; url: string }>
}

export interface MemberInfo {
    id: string
    userId: string
    name: string
    description: string
    joinedAt: number
}

export interface JoinResult {
    roomId: string
    roomName: string
    members: MemberInfo[]
    messages: ChatMessage[]
    rooms: string[]
}

// ─── SSE Client ─────────────────────────────────────────────

let eventSource: EventSource | null = null
let _connectedRoomIds = new Set<string>()

function getBaseUrl(): string {
    const base = (window as any).__HERMES_BASE_URL__ || ''
    if (!base) {
        // Derive from current location
        return window.location.origin
    }
    return base
}

function actionUrl(action: string): string {
    const token = getApiKey()
    const sep = action.includes('?') ? '&' : '?'
    return `${getBaseUrl()}/api/hermes/group-chat/${action}${sep}token=${encodeURIComponent(token)}`
}

export function connectGroupChat(opts?: { userId?: string; userName?: string; description?: string }): EventSource {
    if (opts?.userId) localStorage.setItem('gc_user_id', opts.userId)
    if (opts?.userName) localStorage.setItem('gc_user_name', opts.userName)
    if (opts?.description) localStorage.setItem('gc_user_description', opts.description)

    // Return existing if connected
    if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
        return eventSource
    }

    // Close old one
    if (eventSource) {
        eventSource.close()
    }

    const userId = getStoredUserId()
    const name = getStoredUserName() || undefined
    const token = getApiKey()
    const params = new URLSearchParams({ userId })
    if (name) params.set('name', name)
    if (token) params.set('token', token)

    eventSource = new EventSource(`${getBaseUrl()}/api/hermes/group-chat/events?${params.toString()}`)

    eventSource.onerror = () => {
        console.warn('[group-chat SSE] connection error, will retry automatically')
    }

    return eventSource
}

export function getGroupChatEventSource(): EventSource | null {
    return eventSource
}

export function disconnectGroupChat(): void {
    if (eventSource) {
        eventSource.close()
        eventSource = null
    }
    _connectedRoomIds.clear()
}

// ─── SSE Action Helpers ─────────────────────────────────────

/** Join a room via SSE. The 'join' event will come back on the SSE stream. */
export function joinRoomViaSSE(roomId: string): void {
    fetch(actionUrl('join-room'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, userId: getStoredUserId(), userName: getStoredUserName() }),
    }).catch(err => console.error('[group-chat] join error:', err))
}

/** Send a message via SSE. */
export function sendMessageViaSSE(roomId: string, content: string): void {
    fetch(actionUrl('send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, userId: getStoredUserId(), content }),
    }).catch(err => console.error('[group-chat] send error:', err))
}

/** Emit typing indicator. */
export function sendTypingViaSSE(roomId: string, isTyping: boolean): void {
    fetch(actionUrl('typing'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, userId: getStoredUserId(), isTyping }),
    }).catch(() => { /* ignore */ })
}

/** Interrupt an agent. */
export function interruptAgentViaSSE(roomId: string, agentId: string): void {
    fetch(actionUrl('interrupt-agent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, agentId }),
    }).catch(err => console.error('[group-chat] interrupt error:', err))
}

/** Respond to tool approval request. */
export function respondApprovalViaSSE(roomId: string, approvalId: string, choice: 'allow' | 'deny'): void {
    fetch(actionUrl('approval-respond'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, approvalId, choice }),
    }).catch(err => console.error('[group-chat] approval respond error:', err))
}

/** Register event listener on the global EventSource for a specific room. */
export function onRoomEvent(roomId: string, event: string, handler: (data: any) => void): () => void {
    const es = eventSource
    if (!es) return () => {}

    const wrapped = (e: MessageEvent) => {
        try {
            const data = JSON.parse(e.data)
            if (data.roomId === roomId || data.room_id === roomId) {
                handler(data)
            }
        } catch { /* ignore */ }
    }
    es.addEventListener(event, wrapped)
    return () => es.removeEventListener(event, wrapped)
}

/** Listen for all general events on a room. */
export function onRoomEvents(roomId: string, handlers: Record<string, (data: any) => void>): () => void {
    const es = eventSource
    if (!es) return () => {}

    const wrappers = new Map<string, (e: MessageEvent) => void>()

    for (const [evt, handler] of Object.entries(handlers)) {
        const wrapped = (e: MessageEvent) => {
            try {
                const data = JSON.parse(e.data)
                if (data.roomId === roomId || data.room_id === roomId) {
                    handler(data)
                }
            } catch { /* ignore */ }
        }
        wrappers.set(evt, wrapped)
        es.addEventListener(evt, wrapped)
    }

    return () => {
        for (const [evt, wrapped] of wrappers.entries()) {
            es.removeEventListener(evt, wrapped)
        }
    }
}

// ─── User Identity ──────────────────────────────────────────

function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0
        const v = c === 'x' ? r : (r & 0x3 | 0x8)
        return v.toString(16)
    })
}

export function getStoredUserId(): string {
    let id = localStorage.getItem('gc_user_id')
    if (!id) {
        id = generateUUID()
        localStorage.setItem('gc_user_id', id)
    }
    return id
}

export function getStoredUserName(): string | null {
    return localStorage.getItem('gc_user_name')
}

// ─── REST API ───────────────────────────────────────────────

export async function createRoom(data: {
    name: string
    inviteCode: string
    agents?: { profile: string; name?: string; description?: string; invited?: boolean }[]
    compression?: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number }
}): Promise<{ room: RoomInfo; agents: RoomAgent[] }> {
    return request('/api/hermes/group-chat/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
}

export async function cloneRoom(roomId: string, data?: { name?: string; inviteCode?: string }): Promise<{ room: RoomInfo; agents: RoomAgent[] }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data || {}),
    })
}

export async function listRooms(): Promise<{ rooms: RoomInfo[] }> {
    return request('/api/hermes/group-chat/rooms')
}

export async function getRoomDetail(roomId: string): Promise<{ room: RoomInfo; messages: ChatMessage[]; agents: RoomAgent[]; members: MemberInfo[] }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}`)
}

export async function joinRoomByCode(code: string): Promise<{ room: RoomInfo }> {
    return request(`/api/hermes/group-chat/rooms/join/${code}`)
}

export async function updateInviteCode(roomId: string, inviteCode: string): Promise<void> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/invite-code`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteCode }),
    })
}

export async function addAgent(roomId: string, data: {
    profile: string
    name?: string
    description?: string
    invited?: boolean
}): Promise<{ agent: RoomAgent }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    })
}

export async function listAgents(roomId: string): Promise<{ agents: RoomAgent[] }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/agents`)
}

export async function removeAgent(roomId: string, agentId: string): Promise<void> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/agents/${agentId}`, {
        method: 'DELETE',
    })
}

export async function deleteRoom(roomId: string): Promise<void> {
    return request(`/api/hermes/group-chat/rooms/${roomId}`, {
        method: 'DELETE',
    })
}

export async function clearRoomContext(roomId: string): Promise<{ success: boolean; room: RoomInfo }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/clear-context`, {
        method: 'POST',
    })
}

export async function updateRoomConfig(roomId: string, config: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number }): Promise<{ room: RoomInfo }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
    })
}

export async function forceCompress(roomId: string): Promise<{ success: boolean; summary: string }> {
    return request(`/api/hermes/group-chat/rooms/${roomId}/compress`, {
        method: 'POST',
    })
}

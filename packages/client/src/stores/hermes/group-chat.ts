import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getApiKey, getBaseUrlValue } from '@/api/client'
import { getDownloadUrl } from '@/api/hermes/download'
import type { Attachment, ContentBlock } from './chat'
import {
    connectGroupChat,
    disconnectGroupChat,
    getStoredUserId,
    getStoredUserName,
    type RoomInfo,
    type RoomAgent,
    type ChatMessage,
    type MemberInfo,
    createRoom,
    listRooms,
    getRoomDetail,
    joinRoomByCode,
    addAgent,
    listAgents,
    removeAgent,
    cloneRoom as cloneRoomApi,
    deleteRoom as deleteRoomApi,
    clearRoomContext,
} from '@/api/hermes/group-chat'

async function uploadGroupFiles(attachments: Attachment[]): Promise<{ name: string; path: string }[]> {
    const formData = new FormData()
    for (const att of attachments) {
        if (att.file) formData.append('file', att.file, att.name)
    }
    const token = getApiKey()
    const res = await fetch('/upload', {
        method: 'POST',
        body: formData,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
    const data = await res.json() as { files: { name: string; path: string }[] }
    return data.files
}

function buildGroupContentBlocks(content: string, attachments: Attachment[], files: { name: string; path: string }[]): ContentBlock[] {
    const blocks: ContentBlock[] = []
    if (content.trim()) blocks.push({ type: 'text', text: content.trim() })
    for (let i = 0; i < files.length; i += 1) {
        const file = files[i]
        const attachment = attachments[i]
        if (attachment?.type.startsWith('image/')) {
            blocks.push({
                type: 'image',
                name: file.name,
                path: file.path,
                media_type: attachment.type,
            })
        } else {
            blocks.push({
                type: 'file',
                name: file.name,
                path: file.path,
                media_type: attachment?.type,
            })
        }
    }
    return blocks
}

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function normalizeLocalFilePath(path: string): string {
    return /^[a-zA-Z]:\\/.test(path) ? path.replace(/\\/g, '/') : path
}

export interface GroupPendingApproval {
    roomId: string
    agentName: string
    approvalId: string
    command: string
    description: string
    choices: Array<'once' | 'session' | 'always' | 'deny'>
    allowPermanent: boolean
    requestedAt: number
}

// SSE action helpers
function actionUrl(action: string): string {
  const token = getApiKey()
  const sep = action.includes('?') ? '&' : '?'
  return `${getBaseUrlValue()}/api/hermes/group-chat/${action}${sep}token=${encodeURIComponent(token)}`
}

async function sseAction(action: string, body: any): Promise<any> {
    const res = await fetch(actionUrl(action), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData?.error || `HTTP ${res.status}`)
    }
    return res.json()
}

export const useGroupChatStore = defineStore('groupChat', () => {
    // ─── State ─────────────────────────────────────────────
    const connected = ref(false)
    const currentRoomId = ref<string | null>(null)
    const rooms = ref<RoomInfo[]>([])
    const messages = ref<ChatMessage[]>([])
    const members = ref<MemberInfo[]>([])
    const agents = ref<RoomAgent[]>([])
    const roomName = ref('')
    const isJoining = ref(false)
    const error = ref<string | null>(null)
    const typingUsers = ref<Map<string, { name: string; timer: ReturnType<typeof setTimeout> }>>(new Map())
    const contextStatuses = ref<Map<string, { agentName: string; status: string }>>(new Map())
    const autoPlaySpeechEnabled = ref(false)
    const pendingApprovals = ref<Map<string, GroupPendingApproval>>(new Map())

    function setAutoPlaySpeech(enabled: boolean) {
        autoPlaySpeechEnabled.value = enabled
    }

    function playMessageSpeech(messageId: string, content: string) {
        window.dispatchEvent(new CustomEvent('auto-play-speech', {
            detail: { messageId, content },
        }))
    }

    // Computed: returns first active status for backward compat
    const contextStatus = computed(() => {
        for (const [, status] of contextStatuses.value) {
            return status
        }
        return null
    })
    const activePendingApproval = computed(() => {
        if (!currentRoomId.value) return null
        for (const approval of pendingApprovals.value.values()) {
            if (approval.roomId === currentRoomId.value) return approval
        }
        return null
    })
    const userId = ref(getStoredUserId())
    const userName = ref(getStoredUserName() || '')

    // ─── Computed ───────────────────────────────────────────
    const sortedMessages = computed(() => mapGroupMessages([...messages.value].sort((a, b) => a.timestamp - b.timestamp)))

    const memberNames = computed(() => {
        return members.value.map(m => m.name)
    })

    const typingNames = computed(() => {
        return Array.from(typingUsers.value.values()).map(u => u.name)
    })

    const typingText = computed(() => {
        const names = typingNames.value
        if (names.length === 0) return ''
        if (names.length === 1) return `${names[0]} is typing...`
        if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`
        return `${names[0]} and ${names.length - 1} others are typing...`
    })

    // ─── Connection ────────────────────────────────────────
    function connect() {
        const es = connectGroupChat({
            userId: userId.value,
            userName: userName.value || undefined,
        })
        console.log('[GroupChat] connecting via SSE...', { userId: userId.value, userName: userName.value })

        es.addEventListener('open', () => {
            console.log('[GroupChat] connected via SSE')
            connected.value = true
            error.value = null
        })

        es.onerror = (ev) => {
            console.error('[GroupChat] SSE error:', ev)
            if (es.readyState === EventSource.CLOSED) {
                console.log('[GroupChat] SSE disconnected')
                connected.value = false
            }
        }

        // Listen for all event types
        const eventTypes = [
            'message', 'message_stream_start', 'message_stream_delta',
            'message_reasoning_delta', 'message_stream_end',
            'member_joined', 'member_left', 'typing', 'stop_typing',
            'context_status', 'approval.requested', 'approval.resolved',
            'room_updated', 'room_cleared',
        ]

        for (const evt of eventTypes) {
            es.addEventListener(evt, (e: MessageEvent) => {
                try {
                    const data = JSON.parse(e.data)
                    handleEvent(evt, data)
                } catch (err) {
                    console.error('[GroupChat] failed to parse event:', evt, err)
                }
            })
        }
    }

    function handleEvent(eventName: string, data: any) {
        switch (eventName) {
            case 'message': {
                const msg = data as ChatMessage
                if (msg.roomId !== currentRoomId.value) return
                const idx = messages.value.findIndex(m => m.id === msg.id)
                const existing = idx >= 0 ? messages.value[idx] : null
                const resolvedMsg = {
                    ...msg,
                    isStreaming: false,
                    attachments: existing?.attachments,
                }
                if (idx >= 0) {
                    messages.value[idx] = resolvedMsg
                    messages.value = [...messages.value]
                } else {
                    messages.value.push(resolvedMsg)
                }
                if (autoPlaySpeechEnabled.value && resolvedMsg.role === 'assistant' && resolvedMsg.content?.trim()) {
                    setTimeout(() => playMessageSpeech(resolvedMsg.id, resolvedMsg.content), 300)
                }
                break
            }
            case 'message_stream_start': {
                const msg = data as ChatMessage
                if (msg.roomId !== currentRoomId.value) return
                messages.value = messages.value.filter(m => !(
                    m.roomId === msg.roomId &&
                    m.senderId === msg.senderId &&
                    m.id !== msg.id &&
                    m.isStreaming &&
                    !m.content?.trim() &&
                    !m.reasoning?.trim() &&
                    !m.tool_calls?.length
                ))
                msg.isStreaming = true
                const idx = messages.value.findIndex(m => m.id === msg.id)
                if (idx >= 0) {
                    messages.value[idx] = { ...messages.value[idx], ...msg, isStreaming: true }
                    messages.value = [...messages.value]
                } else {
                    messages.value.push(msg)
                }
                break
            }
            case 'message_stream_delta': {
                if (data.roomId !== currentRoomId.value) return
                const idx = messages.value.findIndex(m => m.id === data.id)
                if (idx < 0) return
                messages.value[idx] = {
                    ...messages.value[idx],
                    content: messages.value[idx].content + data.delta,
                }
                messages.value = [...messages.value]
                break
            }
            case 'message_reasoning_delta': {
                if (data.roomId !== currentRoomId.value) return
                const idx = messages.value.findIndex(m => m.id === data.id)
                if (idx < 0) return
                messages.value[idx] = {
                    ...messages.value[idx],
                    reasoning: (messages.value[idx].reasoning || '') + data.delta,
                    reasoning_content: (messages.value[idx].reasoning_content || '') + data.delta,
                    isStreaming: true,
                }
                messages.value = [...messages.value]
                break
            }
            case 'message_stream_end': {
                if (data.roomId !== currentRoomId.value) return
                const idx = messages.value.findIndex(m => m.id === data.id)
                if (
                    idx >= 0 &&
                    !messages.value[idx].content?.trim() &&
                    !messages.value[idx].reasoning?.trim() &&
                    !messages.value[idx].tool_calls?.length
                ) {
                    messages.value.splice(idx, 1)
                } else if (idx >= 0) {
                    messages.value[idx] = {
                        ...messages.value[idx],
                        isStreaming: false,
                    }
                    messages.value = [...messages.value]
                }
                break
            }
            case 'member_joined': {
                if (data.roomId === currentRoomId.value) {
                    members.value = data.members
                }
                break
            }
            case 'member_left': {
                if (data.roomId === currentRoomId.value) {
                    members.value = data.members
                }
                break
            }
            case 'typing': {
                if (data.roomId === currentRoomId.value && !typingUsers.value.has(data.userId)) {
                    const timer = setTimeout(() => typingUsers.value.delete(data.userId), 5000)
                    typingUsers.value.set(data.userId, { name: data.userName, timer })
                }
                break
            }
            case 'stop_typing': {
                if (data.roomId === currentRoomId.value && typingUsers.value.has(data.userId)) {
                    const entry = typingUsers.value.get(data.userId)!
                    clearTimeout(entry.timer)
                    typingUsers.value.delete(data.userId)
                }
                break
            }
            case 'context_status': {
                if (data.roomId === currentRoomId.value) {
                    if (data.status === 'ready') {
                        contextStatuses.value.delete(data.agentName)
                        messages.value = messages.value
                            .map(m => (
                                m.senderName === data.agentName && m.isStreaming
                                    ? { ...m, isStreaming: false }
                                    : m
                            ))
                            .filter(m => !(
                                m.senderName === data.agentName &&
                                !m.content?.trim() &&
                                !m.reasoning?.trim() &&
                                !m.tool_calls?.length
                            ))
                    } else {
                        contextStatuses.value.set(data.agentName, { agentName: data.agentName, status: data.status })
                    }
                    contextStatuses.value = new Map(contextStatuses.value)
                }
                break
            }
            case 'approval.requested': {
                if (!data.approval_id) return
                const choices = (Array.isArray(data.choices) ? data.choices : ['once', 'session', 'deny'])
                    .filter((choice: any): choice is GroupPendingApproval['choices'][number] =>
                        choice === 'once' || choice === 'session' || choice === 'always' || choice === 'deny')
                pendingApprovals.value.set(data.approval_id, {
                    roomId: data.roomId,
                    agentName: data.agentName || '',
                    approvalId: data.approval_id,
                    command: data.command || '',
                    description: data.description || '',
                    choices: choices.length ? choices : ['once', 'session', 'deny'],
                    allowPermanent: Boolean(data.allow_permanent),
                    requestedAt: Date.now(),
                })
                pendingApprovals.value = new Map(pendingApprovals.value)
                break
            }
            case 'approval.resolved': {
                if (!data.approval_id) return
                pendingApprovals.value.delete(data.approval_id)
                pendingApprovals.value = new Map(pendingApprovals.value)
                break
            }
            case 'room_updated': {
                const room = rooms.value.find(r => r.id === data.roomId)
                if (room) room.totalTokens = data.totalTokens
                break
            }
            case 'room_cleared': {
                const room = rooms.value.find(r => r.id === data.roomId)
                if (room) room.totalTokens = data.totalTokens
                if (data.roomId === currentRoomId.value) {
                    messages.value = []
                    typingUsers.value.clear()
                    contextStatuses.value.clear()
                    pendingApprovals.value.clear()
                }
                break
            }
        }
    }

    function disconnect() {
        disconnectGroupChat()
        connected.value = false
        currentRoomId.value = null
        messages.value = []
        members.value = []
        agents.value = []
        roomName.value = ''
        typingUsers.value.clear()
        contextStatuses.value.clear()
        pendingApprovals.value.clear()
    }

    function setUserInfo(name: string, description: string) {
        userName.value = name
        localStorage.setItem('gc_user_name', name)
        localStorage.setItem('gc_user_description', description)
    }

    // ─── Room Actions ──────────────────────────────────────
    async function joinRoom(roomId: string) {
        isJoining.value = true
        error.value = null

        try {
            const res = await getRoomDetail(roomId)
            currentRoomId.value = res.room.id
            roomName.value = res.room.name
            messages.value = res.messages
            agents.value = res.agents
            members.value = res.members || []
        } catch (err: any) {
            error.value = err.message
            throw err
        } finally {
            isJoining.value = false
        }

        // Join via SSE action for real-time updates
        try {
            const response = await sseAction('join', {
                roomId,
                name: userName.value || undefined,
                description: localStorage.getItem('gc_user_description') || undefined,
            })
            if (response.members) members.value = response.members
            if (response.agents) agents.value = response.agents
            if (response.typingUsers) {
                for (const u of response.typingUsers) {
                    if (!typingUsers.value.has(u.userId)) {
                        const timer = setTimeout(() => typingUsers.value.delete(u.userId), 5000)
                        typingUsers.value.set(u.userId, { name: u.userName, timer })
                    }
                }
            }
            if (response.contextStatuses) {
                contextStatuses.value = new Map(
                    response.contextStatuses.map((s: any) => [s.agentName, s])
                )
            }
        } catch {
            // Join action is best-effort
        }
    }

    async function sendMessage(content: string, attachments?: Attachment[]) {
        if (!currentRoomId.value) return
        emitStopTyping()
        const messageId = uid()
        let finalContent: string | ContentBlock[] = content.trim()
        if (attachments?.length) {
            const uploaded = await uploadGroupFiles(attachments)
            finalContent = buildGroupContentBlocks(content, attachments, uploaded)
            const urlMap = new Map(uploaded.map(f => {
                return [f.name, getDownloadUrl(normalizeLocalFilePath(f.path), f.name)]
            }))
            messages.value.push({
                id: messageId,
                roomId: currentRoomId.value,
                senderId: userId.value,
                senderName: userName.value || 'You',
                content: JSON.stringify(finalContent),
                timestamp: Date.now(),
                role: 'user',
                attachments: attachments.map(att => ({ ...att, url: urlMap.get(att.name) || att.url, file: undefined })),
            })
        }

        try {
            await sseAction('message', { roomId: currentRoomId.value, id: messageId, content: finalContent })
        } catch (err: any) {
            messages.value = messages.value.filter(m => m.id !== messageId)
            throw err
        }
    }

    async function loadRooms() {
        try {
            const res = await listRooms()
            rooms.value = res.rooms
        } catch (err: any) {
            error.value = err.message
        }
    }

    async function createNewRoom(name: string, inviteCode: string, agentList?: { profile: string; name?: string; description?: string; invited?: boolean }[], compression?: { triggerTokens: number; maxHistoryTokens: number; tailMessageCount: number }) {
        try {
            const res = await createRoom({
                name,
                inviteCode,
                agents: agentList,
                compression: compression || { triggerTokens: 100000, maxHistoryTokens: 32000, tailMessageCount: 10 },
            })
            rooms.value.push(res.room)
            return res
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function joinByCode(code: string) {
        try {
            const res = await joinRoomByCode(code)
            await joinRoom(res.room.id)
            return res.room
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function deleteRoom(roomId: string) {
        try {
            await deleteRoomApi(roomId)
            rooms.value = rooms.value.filter(r => r.id !== roomId)
            if (currentRoomId.value === roomId) {
                currentRoomId.value = null
                messages.value = []
                members.value = []
                agents.value = []
                roomName.value = ''
            }
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function cloneRoom(roomId: string, data?: { name?: string; inviteCode?: string }) {
        try {
            const res = await cloneRoomApi(roomId, data)
            rooms.value.push(res.room)
            return res
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function clearCurrentRoomContext() {
        if (!currentRoomId.value) return
        try {
            const res = await clearRoomContext(currentRoomId.value)
            messages.value = []
            typingUsers.value.clear()
            contextStatuses.value.clear()
            const idx = rooms.value.findIndex(r => r.id === currentRoomId.value)
            if (idx >= 0 && res.room) rooms.value[idx] = res.room
            return res
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    // ─── Agent Actions ─────────────────────────────────────
    async function loadAgents(roomId: string) {
        try {
            const res = await listAgents(roomId)
            agents.value = res.agents
        } catch { /* ignore */ }
    }

    async function addAgentToRoom(roomId: string, data: { profile: string; name?: string; description?: string; invited?: boolean }) {
        try {
            const res = await addAgent(roomId, data)
            agents.value.push(res.agent)
            return res.agent
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    async function removeAgentFromRoom(roomId: string, agentId: string) {
        try {
            await removeAgent(roomId, agentId)
            agents.value = agents.value.filter(a => a.id !== agentId)
        } catch (err: any) {
            error.value = err.message
            throw err
        }
    }

    // ─── Typing ────────────────────────────────────────────
    let _typingTimer: ReturnType<typeof setTimeout> | null = null

    function emitTyping() {
        if (!currentRoomId.value) return
        sseAction('typing', { roomId: currentRoomId.value, isTyping: true }).catch(() => {})
        if (_typingTimer) clearTimeout(_typingTimer)
        _typingTimer = setTimeout(() => emitStopTyping(), 4000)
    }

    function emitStopTyping() {
        if (!currentRoomId.value) return
        sseAction('typing', { roomId: currentRoomId.value, isTyping: false }).catch(() => {})
        if (_typingTimer) { clearTimeout(_typingTimer); _typingTimer = null }
    }

    async function interruptAgent(agentName: string) {
        if (!currentRoomId.value) return
        await sseAction('interrupt', { roomId: currentRoomId.value, agentName })
    }

    async function respondApproval(choice: GroupPendingApproval['choices'][number]) {
        const pending = activePendingApproval.value
        if (!pending) return
        await sseAction('approval-respond', {
            roomId: pending.roomId,
            approval_id: pending.approvalId,
            choice,
        })
        pendingApprovals.value.delete(pending.approvalId)
        pendingApprovals.value = new Map(pendingApprovals.value)
    }

    return {
        // State
        connected,
        currentRoomId,
        rooms,
        messages,
        members,
        agents,
        roomName,
        isJoining,
        error,
        contextStatus,
        contextStatuses,
        pendingApprovals,
        activePendingApproval,
        autoPlaySpeechEnabled,
        userId,
        userName,
        // Computed
        sortedMessages,
        memberNames,
        typingNames,
        typingText,
        // Actions
        connect,
        disconnect,
        setUserInfo,
        setAutoPlaySpeech,
        joinRoom,
        sendMessage,
        loadRooms,
        emitTyping,
        emitStopTyping,
        interruptAgent,
        respondApproval,
        createNewRoom,
        joinByCode,
        deleteRoom,
        cloneRoom,
        clearCurrentRoomContext,
        loadAgents,
        addAgentToRoom,
        removeAgentFromRoom,
    }
})

function mapGroupMessages(msgs: ChatMessage[]): ChatMessage[] {
    const toolNameMap = new Map<string, string>()
    const toolArgsMap = new Map<string, string>()
    for (const msg of msgs) {
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
            for (const tc of msg.tool_calls) {
                if (!tc?.id) continue
                if (tc.function?.name) toolNameMap.set(tc.id, tc.function.name)
                if (tc.function?.arguments) toolArgsMap.set(tc.id, tc.function.arguments)
            }
        }
    }

    const result: ChatMessage[] = []
    for (const msg of msgs) {
        if (
            msg.role !== 'tool' &&
            !msg.tool_calls?.length &&
            !msg.content?.trim() &&
            !msg.reasoning?.trim() &&
            (!msg.isStreaming || msg.finish_reason === 'streaming')
        ) {
            continue
        }

        if (msg.role === 'assistant' && msg.tool_calls?.length && !msg.content?.trim()) {
            for (const tc of msg.tool_calls) {
                result.push({
                    ...msg,
                    id: `${msg.id}_${tc.id}`,
                    role: 'tool',
                    content: '',
                    toolName: tc.function?.name || undefined,
                    toolCallId: tc.id,
                    toolArgs: tc.function?.arguments || undefined,
                    toolStatus: 'running',
                })
            }
            continue
        }

        if (msg.role === 'tool') {
            const tcId = msg.tool_call_id || ''
            const toolName = msg.tool_name || toolNameMap.get(tcId) || undefined
            const toolArgs = toolArgsMap.get(tcId) || undefined
            let preview = ''
            if (msg.content) {
                try {
                    const parsed = JSON.parse(msg.content)
                    preview = parsed.url || parsed.title || parsed.preview || parsed.summary || ''
                } catch {
                    preview = msg.content.slice(0, 80)
                }
            }
            const placeholderIdx = result.findIndex(
                m => m.role === 'tool' && m.toolCallId === tcId && !m.toolResult
            )
            const merged: ChatMessage = {
                ...msg,
                id: placeholderIdx !== -1 ? result[placeholderIdx].id : msg.id,
                senderId: placeholderIdx !== -1 ? result[placeholderIdx].senderId : msg.senderId,
                senderName: placeholderIdx !== -1 ? result[placeholderIdx].senderName : msg.senderName,
                timestamp: placeholderIdx !== -1 ? result[placeholderIdx].timestamp : msg.timestamp,
                role: 'tool',
                content: '',
                toolName: toolName || (placeholderIdx !== -1 ? result[placeholderIdx].toolName : undefined),
                toolCallId: tcId || undefined,
                toolArgs: toolArgs || (placeholderIdx !== -1 ? result[placeholderIdx].toolArgs : undefined),
                toolPreview: typeof preview === 'string' ? preview.slice(0, 100) || undefined : undefined,
                toolResult: msg.content || undefined,
                toolStatus: 'done',
            }
            if (placeholderIdx !== -1) result[placeholderIdx] = merged
            else result.push(merged)
            continue
        }

        result.push(msg)
    }
    return result
}

import type { ChatRunSocket } from '../../services/hermes/run-chat'
import type { SseChatRun } from '../../services/hermes/run-chat/sse-chat-run'

let chatRunServer: ChatRunSocket | null = null
let sseChatRunServer: SseChatRun | null = null

export function setChatRunServer(server: ChatRunSocket | SseChatRun): void {
    chatRunServer = server as ChatRunSocket
}

export function getChatRunServer(): ChatRunSocket | SseChatRun | null {
    return (sseChatRunServer || chatRunServer) as any
}

export function setSseChatRunServer(server: SseChatRun): void {
    sseChatRunServer = server
}

export function getSseChatRunServer(): SseChatRun | null {
    return sseChatRunServer
}

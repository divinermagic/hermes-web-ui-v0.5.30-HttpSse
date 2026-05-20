import { logger } from './logger'
import { closeDb } from '../db'

export function bindShutdown(server: any, groupChatServer?: any, chatRunServer?: any, agentBridgeManager?: any): void {
  let isShuttingDown = false

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    // Force exit after 3s no matter what
    setTimeout(() => process.exit(0), 3000)

    logger.info('Shutting down (%s)...', signal)
    console.log(`[shutdown] Received signal: ${signal}`)

    try {
      if (agentBridgeManager) {
        try {
          await agentBridgeManager.stop()
          logger.info('Agent bridge stopped')
        } catch (err) {
          logger.warn(err, 'Failed to stop agent bridge (non-fatal)')
        }
      }

      // Close ChatRun server first to abort all active runs
      if (chatRunServer) {
        chatRunServer.close()
        logger.info('ChatRun server closed')
      }

      // Disconnect GroupChat server
      if (groupChatServer) {
        // Support both Socket.IO and SSE group chat servers
        if (typeof groupChatServer.close === 'function') {
          groupChatServer.close()
        } else if (groupChatServer.agentClients?.disconnectAll) {
          groupChatServer.agentClients.disconnectAll()
        }
        if (groupChatServer.getIO) {
          groupChatServer.getIO().close()
        }
        logger.info('GroupChat server closed')
      }

      const servers = Array.isArray(server) ? server : [server].filter(Boolean)
      if (servers.length) {
        await Promise.all(servers.map((httpServer) => (
          new Promise<void>((resolve) => {
            httpServer.close(() => {
              logger.info('HTTP server closed')
              resolve()
            })
          })
        )))
      }
    } catch (err) {
      logger.error(err, 'Shutdown error')
    }

    closeDb()
    process.exit(0)
  }

  process.once('SIGUSR2', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

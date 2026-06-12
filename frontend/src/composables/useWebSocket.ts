import { ref, type Ref } from 'vue'

export interface UseWebSocket {
  connected: Ref<boolean>
  connect: (sessionId: string) => void
  disconnect: () => void
  onMessage: (handler: (event: any) => void) => void
  onUnexpectedClose: (handler: () => void) => void
}

export function useWebSocket(): UseWebSocket {
  const connected = ref(false)
  let ws: WebSocket | null = null
  let messageHandler: ((event: any) => void) | null = null
  let closeHandler: (() => void) | null = null

  function getWsUrl(sessionId: string): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = import.meta.env.VITE_API_BASE_URL
      ? new URL(import.meta.env.VITE_API_BASE_URL).host
      : window.location.host
    return `${proto}//${host}/api/v1/sessions/${sessionId}/ws`
  }

  function connect(sessionId: string) {
    disconnect()

    ws = new WebSocket(getWsUrl(sessionId))

    ws.onopen = () => {
      connected.value = true
    }

    ws.onclose = () => {
      connected.value = false
      // Unexpected close (network drop, server gone). Intentional closes
      // go through disconnect(), which clears this handler first.
      closeHandler?.()
    }

    ws.onerror = () => {
      ws?.close()
    }

    ws.onmessage = (e) => {
      if (!messageHandler) return
      try {
        const data = JSON.parse(e.data)
        messageHandler(data)
      } catch {
        // ignore malformed messages
      }
    }
  }

  function disconnect() {
    if (ws) {
      ws.onclose = null
      ws.onerror = null
      ws.close()
      ws = null
    }
    connected.value = false
  }

  function onMessage(handler: (event: any) => void) {
    messageHandler = handler
  }

  function onUnexpectedClose(handler: () => void) {
    closeHandler = handler
  }

  return { connected, connect, disconnect, onMessage, onUnexpectedClose }
}

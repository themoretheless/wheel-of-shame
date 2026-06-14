import { ref, type Ref } from 'vue'

export interface UseWebSocket {
  connected: Ref<boolean>
  connect: (sessionId: string) => void
  disconnect: () => void
  onMessage: (handler: (event: any) => void) => void
  onOpen: (handler: () => void) => void
  onUnexpectedClose: (handler: () => void) => void
}

/**
 * Build the WebSocket URL for a session. Pure (no globals) so it can be
 * unit-tested: the page protocol/host and the optional API base override are
 * passed in. `https:` upgrades to `wss:`, anything else stays plaintext `ws:`.
 */
export function buildWsUrl(
  sessionId: string,
  pageProtocol: string,
  pageHost: string,
  apiBaseUrl?: string,
): string {
  const proto = pageProtocol === 'https:' ? 'wss:' : 'ws:'
  const host = apiBaseUrl ? new URL(apiBaseUrl).host : pageHost
  return `${proto}//${host}/api/v1/sessions/${sessionId}/ws`
}

export function useWebSocket(): UseWebSocket {
  const connected = ref(false)
  let ws: WebSocket | null = null
  let messageHandler: ((event: any) => void) | null = null
  let openHandler: (() => void) | null = null
  let closeHandler: (() => void) | null = null

  function getWsUrl(sessionId: string): string {
    return buildWsUrl(
      sessionId,
      window.location.protocol,
      window.location.host,
      import.meta.env.VITE_API_BASE_URL,
    )
  }

  function connect(sessionId: string) {
    disconnect()

    ws = new WebSocket(getWsUrl(sessionId))

    ws.onopen = () => {
      connected.value = true
      openHandler?.()
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

  function onOpen(handler: () => void) {
    openHandler = handler
  }

  function onUnexpectedClose(handler: () => void) {
    closeHandler = handler
  }

  return { connected, connect, disconnect, onMessage, onOpen, onUnexpectedClose }
}

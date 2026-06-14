import { ref } from 'vue'

// Lightweight toast queue (Linear-style): a module-level reactive list so any
// part of the app (WS handlers in useSession, copyLink in App) can drop a
// transient note without prop-drilling. ToastStack.vue renders the queue.

export type ToastKind = 'info' | 'success' | 'spin'

export interface Toast {
  id: number
  message: string
  kind: ToastKind
  // Optional identity color for a tinted left accent (e.g. a spin winner's hue),
  // matching the same per-name color the wheel and roster use.
  accent?: string
}

const toasts = ref<Toast[]>([])
// Cap the visible stack so a burst of events (a batch add, rapid spins) can't
// pile the screen full; the oldest is dropped as new ones arrive.
const MAX_TOASTS = 4
const DEFAULT_TTL_MS = 3200

let nextId = 1
// Per-toast dismissal timers, cleared on manual dismiss so a toast removed by
// hand doesn't leave a dangling timeout that later splices an unrelated entry.
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function dismiss(id: number) {
  const timer = timers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

function push(message: string, kind: ToastKind = 'info', accent?: string) {
  const id = nextId++
  toasts.value.push({ id, message, kind, accent })
  // Trim the oldest beyond the cap so the stack stays bounded.
  while (toasts.value.length > MAX_TOASTS) {
    const dropped = toasts.value.shift()
    if (dropped) {
      const timer = timers.get(dropped.id)
      if (timer !== undefined) {
        clearTimeout(timer)
        timers.delete(dropped.id)
      }
    }
  }
  timers.set(
    id,
    setTimeout(() => dismiss(id), DEFAULT_TTL_MS),
  )
}

export function useToasts() {
  return {
    toasts,
    push,
    dismiss,
  }
}

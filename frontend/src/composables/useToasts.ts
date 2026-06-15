import { ref } from 'vue'

// Lightweight toast queue (Linear-style): a module-level reactive list so any
// part of the app (WS handlers in useSession, copyLink in App) can drop a
// transient note without prop-drilling. ToastStack.vue renders the queue.

export type ToastKind = 'info' | 'success' | 'spin' | 'warn'

export interface Toast {
  id: number
  message: string
  kind: ToastKind
  // Optional identity color for a tinted left accent (e.g. a spin winner's hue),
  // matching the same per-name color the wheel and roster use.
  accent?: string
  // Sticky toasts never auto-dismiss; they stay until explicitly dismissed or
  // converted to a timed toast (used for connection state, which must persist
  // until the socket is back). Default is a timed toast.
  sticky?: boolean
}

// Patch accepted by update(): re-message or re-style a live toast in place, e.g.
// turning a sticky "reconnecting…" pill into a timed "reconnected" one.
export interface ToastPatch {
  message?: string
  kind?: ToastKind
  accent?: string
  sticky?: boolean
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

function push(
  message: string,
  kind: ToastKind = 'info',
  accent?: string,
  sticky = false,
): number {
  const id = nextId++
  toasts.value.push({ id, message, kind, accent, sticky })
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
  // Sticky toasts get no dismissal timer; they persist until dismiss() or an
  // update() that clears the sticky flag arms one.
  if (!sticky) {
    timers.set(
      id,
      setTimeout(() => dismiss(id), DEFAULT_TTL_MS),
    )
  }
  return id
}

// Re-message or re-style a live toast in place, returning whether it was found.
// Clearing a sticky toast's sticky flag arms a fresh TTL so a "reconnecting…"
// pill can flip to a timed "reconnected" one without restacking. A no-op (and
// false) if the toast was already dismissed or trimmed off the cap.
function update(id: number, patch: ToastPatch): boolean {
  const toast = toasts.value.find((t) => t.id === id)
  if (!toast) return false
  if (patch.message !== undefined) toast.message = patch.message
  if (patch.kind !== undefined) toast.kind = patch.kind
  if (patch.accent !== undefined) toast.accent = patch.accent
  if (patch.sticky !== undefined && patch.sticky !== toast.sticky) {
    toast.sticky = patch.sticky
    const existing = timers.get(id)
    if (patch.sticky) {
      // Became sticky: cancel any pending auto-dismissal.
      if (existing !== undefined) {
        clearTimeout(existing)
        timers.delete(id)
      }
    } else if (existing === undefined) {
      // No longer sticky and untimed: arm the standard TTL.
      timers.set(
        id,
        setTimeout(() => dismiss(id), DEFAULT_TTL_MS),
      )
    }
  }
  return true
}

export function useToasts() {
  return {
    toasts,
    push,
    dismiss,
    update,
  }
}

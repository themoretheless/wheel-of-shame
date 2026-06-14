import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToasts } from './useToasts'

// The queue is module-level (shared singleton), so each test drains it first to
// stay independent of ordering.
function drain() {
  const { toasts, dismiss } = useToasts()
  for (const t of [...toasts.value]) dismiss(t.id)
}

describe('useToasts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    drain()
  })

  afterEach(() => {
    drain()
    vi.useRealTimers()
  })

  it('pushes a toast onto the queue', () => {
    const { toasts, push } = useToasts()
    push('hello')
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0].message).toBe('hello')
    expect(toasts.value[0].kind).toBe('info')
  })

  it('caps the stack at four, dropping the oldest', () => {
    const { toasts, push } = useToasts()
    for (let i = 0; i < 6; i++) push(`t${i}`)
    expect(toasts.value).toHaveLength(4)
    // The two oldest (t0, t1) were trimmed; the newest survive in order.
    expect(toasts.value.map((t) => t.message)).toEqual(['t2', 't3', 't4', 't5'])
  })

  it('auto-dismisses after the TTL', () => {
    const { toasts, push } = useToasts()
    push('temp')
    expect(toasts.value).toHaveLength(1)
    vi.advanceTimersByTime(3200)
    expect(toasts.value).toHaveLength(0)
  })

  it('dismiss removes a specific toast by id', () => {
    const { toasts, push, dismiss } = useToasts()
    push('a')
    push('b')
    const firstId = toasts.value[0].id
    dismiss(firstId)
    expect(toasts.value.map((t) => t.message)).toEqual(['b'])
  })

  it('carries an accent color through', () => {
    const { toasts, push } = useToasts()
    push('tinted', 'spin', 'hsl(120, 62%, 66%)')
    expect(toasts.value[0].accent).toBe('hsl(120, 62%, 66%)')
    expect(toasts.value[0].kind).toBe('spin')
  })
})

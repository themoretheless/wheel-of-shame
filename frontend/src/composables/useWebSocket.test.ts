import { describe, expect, it } from 'vitest'
import { buildWsUrl } from './useWebSocket'

describe('buildWsUrl', () => {
  it('uses ws:// for a plain-http page', () => {
    expect(buildWsUrl('abc', 'http:', 'example.com:8080')).toBe(
      'ws://example.com:8080/api/v1/sessions/abc/ws',
    )
  })

  it('upgrades to wss:// for an https page', () => {
    expect(buildWsUrl('abc', 'https:', 'example.com')).toBe(
      'wss://example.com/api/v1/sessions/abc/ws',
    )
  })

  it('prefers the host from an explicit API base override', () => {
    expect(
      buildWsUrl('s1', 'https:', 'frontend.example.com', 'https://api.example.com:9000'),
    ).toBe('wss://api.example.com:9000/api/v1/sessions/s1/ws')
  })

  it('falls back to the page host when the override is empty', () => {
    expect(buildWsUrl('s1', 'http:', 'localhost:5173', '')).toBe(
      'ws://localhost:5173/api/v1/sessions/s1/ws',
    )
  })
})

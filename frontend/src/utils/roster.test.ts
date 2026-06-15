import { describe, expect, it } from 'vitest'
import { parsePastedNames } from './roster'

describe('parsePastedNames', () => {
  it('splits a newline-separated column', () => {
    expect(parsePastedNames('Ada\nAlan\nGrace', [])).toEqual([
      'Ada',
      'Alan',
      'Grace',
    ])
  })

  it('splits on commas and tabs too', () => {
    expect(parsePastedNames('Ada, Alan\tGrace', [])).toEqual([
      'Ada',
      'Alan',
      'Grace',
    ])
  })

  it('trims whitespace and drops empty tokens', () => {
    expect(parsePastedNames('  Ada  \n\n , \t Alan ,', [])).toEqual([
      'Ada',
      'Alan',
    ])
  })

  it('dedupes within the paste case-insensitively, keeping first spelling', () => {
    expect(parsePastedNames('Ada\nada\nADA\nAlan', [])).toEqual(['Ada', 'Alan'])
  })

  it('dedupes against existing names case-insensitively', () => {
    expect(parsePastedNames('Ada\nAlan\nGrace', ['  alan '])).toEqual([
      'Ada',
      'Grace',
    ])
  })

  it('returns an empty array when nothing new remains', () => {
    expect(parsePastedNames('Ada\nAlan', ['Ada', 'Alan'])).toEqual([])
  })

  it('preserves paste order', () => {
    expect(parsePastedNames('Zoe\nAlan\nByron', [])).toEqual([
      'Zoe',
      'Alan',
      'Byron',
    ])
  })
})

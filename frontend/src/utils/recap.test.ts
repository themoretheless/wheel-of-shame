import { describe, expect, it } from 'vitest'
import { buildPodium, buildRecapSummary } from './recap'
import type { Participant } from '../types'

function part(name: string, spin_order?: number): Participant {
  return {
    id: name,
    session_id: 's',
    name,
    removed: spin_order !== undefined,
    spin_order,
  }
}

describe('buildRecapSummary', () => {
  it('lists the title, survivor and picked names in spin order', () => {
    const picked = [part('Ada', 1), part('Alan', 2)]
    const survivor = part('Grace')
    expect(buildRecapSummary('Sprint demo', picked, survivor)).toBe(
      ['Sprint demo', 'Survivor: Grace', '2 off the wheel, in order:', '1. Ada', '2. Alan'].join(
        '\n',
      ),
    )
  })

  it('notes when nobody survived', () => {
    expect(buildRecapSummary('Run', [part('Ada', 1)], null)).toBe(
      ['Run', 'Survivor: nobody made it', '1 off the wheel, in order:', '1. Ada'].join('\n'),
    )
  })

  it('falls back to a default heading when the title is blank', () => {
    expect(buildRecapSummary('   ', [], part('Grace'))).toBe(
      ['Wheel of Shame', 'Survivor: Grace', '0 off the wheel, in order:'].join('\n'),
    )
  })

  it('falls back to the array index when spin_order is missing', () => {
    const picked = [part('Ada'), part('Alan')]
    expect(buildRecapSummary('Run', picked, null)).toBe(
      ['Run', 'Survivor: nobody made it', '2 off the wheel, in order:', '1. Ada', '2. Alan'].join(
        '\n',
      ),
    )
  })
})

describe('buildPodium', () => {
  it('maps the first three picked names onto medal tiers in spin order', () => {
    const picked = [part('Ada', 1), part('Alan', 2), part('Grace', 3), part('Linus', 4)]
    expect(buildPodium(picked)).toEqual([
      { tier: 'gold', rank: 1, name: 'Ada' },
      { tier: 'silver', rank: 2, name: 'Alan' },
      { tier: 'bronze', rank: 3, name: 'Grace' },
    ])
  })

  it('returns fewer rows when fewer than three names were picked', () => {
    expect(buildPodium([part('Ada', 1)])).toEqual([{ tier: 'gold', rank: 1, name: 'Ada' }])
    expect(buildPodium([])).toEqual([])
  })

  it('falls back to the array index when spin_order is missing', () => {
    expect(buildPodium([part('Ada'), part('Alan')])).toEqual([
      { tier: 'gold', rank: 1, name: 'Ada' },
      { tier: 'silver', rank: 2, name: 'Alan' },
    ])
  })
})

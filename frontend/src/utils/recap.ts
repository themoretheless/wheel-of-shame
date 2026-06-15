// Survivor coronation share card (Stripe-style copy-to-share). Turns a finished
// run into a plain-text summary the host can paste into chat: the session title,
// the survivor, then every eliminated name in spin order. Pure so it can be
// unit-tested and reused by the RecapReel copy button.

import type { Participant } from '../types'

// Build the shareable run summary. `picked` is the eliminated roster in spin
// order (earliest first, as removedParticipants already provides); `survivor` is
// the lone name left on the wheel, or null if none remains. The output is a
// single string with a trailing newline-free body so it pastes cleanly.
export function buildRecapSummary(
  title: string,
  picked: readonly Participant[],
  survivor: Participant | null,
): string {
  const lines: string[] = []
  const heading = title.trim() || 'Wheel of Shame'
  lines.push(heading)
  lines.push(
    survivor ? `Survivor: ${survivor.name}` : 'Survivor: nobody made it',
  )
  lines.push(`${picked.length} off the wheel, in order:`)
  picked.forEach((p, i) => {
    lines.push(`${p.spin_order ?? i + 1}. ${p.name}`)
  })
  return lines.join('\n')
}

// A single podium row on the exportable trophy card: the medal tier, the 1-based
// elimination rank, and the eliminated name. Mirrors NameList's medal tiers (the
// first three names off the wheel earn gold/silver/bronze in a wheel of shame).
export interface PodiumRow {
  tier: 'gold' | 'silver' | 'bronze'
  rank: number
  name: string
}

// The medal colors the trophy card draws, matching NameList's --medal tokens so
// the shared card reads the same as the live roster.
export const PODIUM_COLORS: Record<PodiumRow['tier'], string> = {
  gold: '#ffd54a',
  silver: '#cfd8dc',
  bronze: '#d99c66',
}

// Pick the podium (first three off the wheel) for the trophy card, in spin
// order. `picked` is already earliest-first, so the slice maps straight onto the
// gold/silver/bronze tiers. Rank uses spin_order when present, else the position.
export function buildPodium(picked: readonly Participant[]): PodiumRow[] {
  const tiers: PodiumRow['tier'][] = ['gold', 'silver', 'bronze']
  return picked.slice(0, 3).map((p, i) => ({
    tier: tiers[i],
    rank: p.spin_order ?? i + 1,
    name: p.name,
  }))
}

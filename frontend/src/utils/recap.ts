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

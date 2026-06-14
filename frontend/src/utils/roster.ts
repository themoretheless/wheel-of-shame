// Roster paste parsing (Linear/Notion paste-to-list). A clipboard blob is
// commonly a column or comma list of names; this turns it into clean, deduped
// tokens ready for the add-batch path.

// Split a pasted blob into clean name tokens: break on newlines, commas and
// tabs, trim each, drop empties, then dedupe (case-insensitively, first
// spelling wins) against `existing` names and against earlier tokens in the
// same paste. Returned in paste order. Pure so it can be unit-tested.
export function parsePastedNames(
  text: string,
  existing: readonly string[],
): string[] {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()))
  const out: string[] = []
  for (const raw of text.split(/[\n,\t]+/)) {
    const name = raw.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (taken.has(key)) continue
    taken.add(key)
    out.push(name)
  }
  return out
}

// Personal name comparison tolerant of common variations:
//   - "Matt" vs "Matthew" (nickname / formal)
//   - "Matt Trent" vs "Matt R Trent" (middle initials)
//   - "José" vs "Jose" (diacritics)
//   - "Matt Trent" vs "matt trent" (case)
//
// Last names must still match exactly — that's the most stable identifier
// and avoids matching a different "Matt Smith" when you're "Matt Trent".

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const an = normalize(a ?? '')
  const bn = normalize(b ?? '')
  if (!an || !bn) return false
  if (an === bn) return true

  const at = an.split(' ')
  const bt = bn.split(' ')

  // Single-word names: prefix-or-equal on the only token.
  if (at.length === 1 && bt.length === 1) {
    return at[0].startsWith(bt[0]) || bt[0].startsWith(at[0])
  }

  // Multi-word: last names must match exactly; first names match if either
  // is a prefix of the other (covers Matt/Matthew, Sam/Samuel, etc.).
  const aLast = at[at.length - 1]
  const bLast = bt[bt.length - 1]
  if (aLast !== bLast) return false

  const aFirst = at[0]
  const bFirst = bt[0]
  return aFirst.startsWith(bFirst) || bFirst.startsWith(aFirst)
}

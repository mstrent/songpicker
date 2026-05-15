// Compares two song titles for "same song" purposes when matching an
// AI-proposed title against a Planning Center library entry. A pure
// equality check is too strict — it misses real matches over leading
// articles ("Lion and the Lamb" vs "The Lion and the Lamb"), curly
// vs straight apostrophes (CCLI-paste artifact), and "&" vs "and"
// (publisher-style vs lyrics-style rendering of the same title).
//
// Deliberately NOT fuzzy: no edit-distance tolerance, no token
// reordering, no stop-word removal beyond a leading article. The
// false-positive risk on worship titles is real — see the
// "I Surrender" / "Surrender" case in PCO's substring filter that
// motivated the original strict equality. Normalization here only
// drops differences that are virtually never meaningful.
function normalize(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .replace(/^(?:the|a|an)\s+/, '')
    .trim()
}

export function titlesMatch(a: string, b: string): boolean {
  const na = normalize(a)
  const nb = normalize(b)
  if (!na || !nb) return false
  return na === nb
}

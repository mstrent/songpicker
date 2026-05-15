// Lowercase + light folding for comparing song-identifying strings
// (titles, authors) across sources that render the same value in
// inconsequentially different ways: CCLI's curly apostrophes,
// publisher-style "&" vs lyrics-style "and", leading articles that
// some catalogs include and others omit, NFKC compatibility forms
// from font ligatures.
//
// Deliberately NOT fuzzy: no edit-distance tolerance, no token
// reordering, no stop-word removal beyond a single leading article.
// Used by titlesMatch (PCO library lookup) and the lyrics cache key.
// Anything more aggressive risks collapsing distinct songs.
export function normalizeText(title: string): string {
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

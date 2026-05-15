import { describe, expect, it } from 'vitest'

import { titlesMatch } from './titleMatch'

describe('titlesMatch', () => {
  it('matches identical titles', () => {
    expect(titlesMatch('Reckless Love', 'Reckless Love')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(titlesMatch('reckless love', 'RECKLESS LOVE')).toBe(true)
  })

  it('matches when one side has a leading "The" and the other does not', () => {
    expect(titlesMatch('Lion and the Lamb', 'The Lion and the Lamb')).toBe(true)
    expect(titlesMatch('The Lion and the Lamb', 'Lion and the Lamb')).toBe(true)
  })

  it('matches when one side has a leading "A" and the other does not', () => {
    expect(titlesMatch('A Mighty Fortress', 'Mighty Fortress')).toBe(true)
  })

  it('matches when one side has a leading "An" and the other does not', () => {
    expect(titlesMatch('An Hour With Jesus', 'Hour With Jesus')).toBe(true)
  })

  it('treats "&" and "and" as equivalent', () => {
    expect(titlesMatch('Bread & Wine', 'Bread and Wine')).toBe(true)
  })

  it('treats curly and straight apostrophes as equivalent', () => {
    expect(titlesMatch("It’s Your Breath", "It's Your Breath")).toBe(true)
  })

  it('does not match when titles differ on a non-article word', () => {
    // The Surrender false-positive guard — "I" is not in the article list,
    // so dropping it would be the kind of overreach that links the AI's
    // "Surrender" by Marc James to the library's "I Surrender All" before
    // the author tiebreaker can run. Belt-and-suspenders alongside the
    // existing exact-equality assumption.
    expect(titlesMatch('Surrender', 'I Surrender')).toBe(false)
    expect(titlesMatch('Surrender', 'I Surrender All')).toBe(false)
  })

  it('does not match unrelated titles that happen to share a word', () => {
    expect(titlesMatch('Holy Spirit', 'Holy, Holy, Holy')).toBe(false)
  })

  it('does not match a bare leading article against itself', () => {
    // "The" alone shouldn't normalize to empty and then match anything;
    // both sides would normalize to '' which is a degenerate true.
    expect(titlesMatch('The', 'The Lion and the Lamb')).toBe(false)
  })
})

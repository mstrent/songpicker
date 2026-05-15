import { describe, expect, it } from 'vitest'

import { normalizeText } from './normalize'

describe('normalizeText', () => {
  it('lowercases and trims', () => {
    expect(normalizeText('  Reckless Love  ')).toBe('reckless love')
  })

  it('folds curly apostrophes to straight', () => {
    expect(normalizeText("It’s Your Breath")).toBe("it's your breath")
  })

  it('folds curly double quotes to straight', () => {
    expect(normalizeText("“Holy”")).toBe('"holy"')
  })

  it('treats "&" as "and"', () => {
    expect(normalizeText('Bread & Wine')).toBe('bread and wine')
  })

  it('collapses runs of whitespace', () => {
    expect(normalizeText('Holy   Spirit')).toBe('holy spirit')
  })

  it('strips a single leading article', () => {
    expect(normalizeText('The Lion and the Lamb')).toBe('lion and the lamb')
    expect(normalizeText('A Mighty Fortress')).toBe('mighty fortress')
    expect(normalizeText('An Hour With Jesus')).toBe('hour with jesus')
  })

  it('applies NFKC compatibility normalization', () => {
    // U+FB01 (ﬁ ligature) NFKC-decomposes to "fi"
    expect(normalizeText('Sanctiﬁed')).toBe('sanctified')
  })

  it('returns empty string when given empty input', () => {
    expect(normalizeText('')).toBe('')
    expect(normalizeText('   ')).toBe('')
  })
})

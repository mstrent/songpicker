import { describe, expect, it } from 'vitest'
import { translateAiAssignments, type TranslatableCandidate } from './aiTranslate'

function cand(
  partial: Partial<TranslatableCandidate> & Pick<TranslatableCandidate, 'id'>,
): TranslatableCandidate {
  return {
    id: partial.id,
    suggestion: partial.suggestion ?? { title: `Title for ${partial.id}` },
    song: partial.song,
  }
}

describe('translateAiAssignments', () => {
  it('passes null candidateId through as a clear assignment', () => {
    const result = translateAiAssignments(
      [{ slotIndex: 3, candidateId: null }],
      [],
    )
    expect(result.assignments).toEqual([{ slotIndex: 3, song: null }])
    expect(result.warnings).toEqual([])
  })

  it('looks up the candidate and produces a song-ref assignment', () => {
    const candidates = [
      cand({
        id: 'c1',
        suggestion: { title: 'Build My Life' },
        song: { id: 'song-bml', title: 'Build My Life' },
      }),
    ]
    const result = translateAiAssignments(
      [{ slotIndex: 1, candidateId: 'c1' }],
      candidates,
    )
    expect(result.assignments).toEqual([
      {
        slotIndex: 1,
        song: { id: 'song-bml', title: 'Build My Life' },
      },
    ])
    expect(result.warnings).toEqual([])
  })

  it('uses the AI-proposed suggestion title (not the matched library title) for songTitle', () => {
    // The AI says "Surrender" — that's the title we want PCO to
    // show. The library may have it stored as "Surrender (full
    // band)" or similar; the AI's title is what the user typed
    // about / what shows in the chat log.
    const candidates = [
      cand({
        id: 'c1',
        suggestion: { title: 'Surrender' },
        song: { id: 'song-x', title: 'Surrender (full band)' },
      }),
    ]
    const result = translateAiAssignments(
      [{ slotIndex: 1, candidateId: 'c1' }],
      candidates,
    )
    expect(result.assignments[0].song?.title).toBe('Surrender')
  })

  it('warns + skips when AI references an unknown candidate id', () => {
    const result = translateAiAssignments(
      [{ slotIndex: 1, candidateId: 'c-nonexistent' }],
      [],
    )
    expect(result.assignments).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/unknown candidate/)
  })

  it('warns + skips when candidate has no matched library song', () => {
    const candidates = [
      cand({
        id: 'c1',
        suggestion: { title: 'Untitled' },
        song: undefined,
      }),
    ]
    const result = translateAiAssignments(
      [{ slotIndex: 1, candidateId: 'c1' }],
      candidates,
    )
    expect(result.assignments).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/isn't matched to a song/)
  })

  it('handles a mixed batch with some valid + some invalid', () => {
    const candidates = [
      cand({
        id: 'c-good',
        suggestion: { title: 'Good Song' },
        song: { id: 'song-good', title: 'Good Song' },
      }),
      cand({
        id: 'c-unmatched',
        suggestion: { title: 'Unmatched' },
        song: undefined,
      }),
    ]
    const result = translateAiAssignments(
      [
        { slotIndex: 1, candidateId: 'c-good' },
        { slotIndex: 2, candidateId: 'c-unmatched' },
        { slotIndex: 3, candidateId: 'c-missing' },
        { slotIndex: 4, candidateId: null },
      ],
      candidates,
    )
    expect(result.assignments).toEqual([
      { slotIndex: 1, song: { id: 'song-good', title: 'Good Song' } },
      { slotIndex: 4, song: null },
    ])
    expect(result.warnings).toHaveLength(2)
  })
})

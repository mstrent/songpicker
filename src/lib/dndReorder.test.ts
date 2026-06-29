import { describe, expect, it } from 'vitest'
import { reorderInsertIndex } from './dndReorder'

// Vertical spans for a list of stacked cards, each 100px tall with a
// 20px gap: midpoints at 50, 170, 290.
const spans = [
  { top: 0, bottom: 100 },
  { top: 120, bottom: 220 },
  { top: 240, bottom: 340 },
]

describe('reorderInsertIndex', () => {
  it('is 0 when the pointer is above every card', () => {
    expect(reorderInsertIndex(-50, spans)).toBe(0)
  })

  it('is 0 in the top half of the first card', () => {
    expect(reorderInsertIndex(10, spans)).toBe(0)
  })

  it('is 1 in the bottom half of the first card', () => {
    expect(reorderInsertIndex(90, spans)).toBe(1)
  })

  it('is 1 in the gap between the first and second card', () => {
    expect(reorderInsertIndex(110, spans)).toBe(1)
  })

  it('is 2 in the gap between the second and third card', () => {
    expect(reorderInsertIndex(230, spans)).toBe(2)
  })

  it('is the length when the pointer is below every card', () => {
    expect(reorderInsertIndex(999, spans)).toBe(3)
  })

  it('treats a pointer exactly on a midpoint as "before" that card', () => {
    // midpoint of the second card is 170; not counted as past it
    expect(reorderInsertIndex(170, spans)).toBe(1)
  })

  it('is 0 for an empty list', () => {
    expect(reorderInsertIndex(123, [])).toBe(0)
  })
})

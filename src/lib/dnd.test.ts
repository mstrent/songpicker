import { describe, expect, it } from 'vitest'
import { dragLeftElement } from './dnd'

// A stand-in for the element we're leaving: contains() reports whether a
// node is one of its descendants, mirroring DOM Node.contains.
function container(...descendants: object[]) {
  return {
    contains: (n: Node | null) => n != null && descendants.includes(n),
  }
}

describe('dragLeftElement', () => {
  it('is false when the cursor moved to a descendant (still inside)', () => {
    const child = {} as unknown as Node
    expect(dragLeftElement(container(child), child)).toBe(false)
  })

  it('is true when the cursor moved to an unrelated element', () => {
    const child = {} as unknown as Node
    const outside = {} as unknown as Node
    expect(dragLeftElement(container(child), outside)).toBe(true)
  })

  it('is true when relatedTarget is null (left the window/document)', () => {
    expect(dragLeftElement(container(), null)).toBe(true)
  })
})

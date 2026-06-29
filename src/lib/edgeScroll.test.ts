import { describe, expect, it } from 'vitest'
import { edgeScrollDelta } from './edgeScroll'

const OPTS = { edge: 60, maxSpeed: 18 }

describe('edgeScrollDelta', () => {
  it('is 0 when the pointer is above the pane', () => {
    expect(edgeScrollDelta(40, 100, 800, OPTS)).toBe(0)
  })

  it('is 0 when the pointer is below the pane', () => {
    expect(edgeScrollDelta(900, 100, 800, OPTS)).toBe(0)
  })

  it('is 0 in the dead zone away from both edges', () => {
    expect(edgeScrollDelta(400, 100, 800, OPTS)).toBe(0)
  })

  it('scrolls up (negative) near the top edge', () => {
    const d = edgeScrollDelta(120, 100, 800, OPTS) // 20px from top
    expect(d).toBeLessThan(0)
    expect(Math.abs(d)).toBeLessThanOrEqual(OPTS.maxSpeed)
  })

  it('reaches max speed at the very top edge', () => {
    expect(edgeScrollDelta(100, 100, 800, OPTS)).toBe(-OPTS.maxSpeed)
  })

  it('scrolls down (positive) near the bottom edge', () => {
    const d = edgeScrollDelta(780, 100, 800, OPTS) // 20px from bottom
    expect(d).toBeGreaterThan(0)
    expect(d).toBeLessThanOrEqual(OPTS.maxSpeed)
  })

  it('reaches max speed at the very bottom edge', () => {
    expect(edgeScrollDelta(800, 100, 800, OPTS)).toBe(OPTS.maxSpeed)
  })

  it('accelerates as the pointer gets closer to an edge', () => {
    const far = Math.abs(edgeScrollDelta(150, 100, 800, OPTS)) // 50px in
    const near = Math.abs(edgeScrollDelta(110, 100, 800, OPTS)) // 10px in
    expect(near).toBeGreaterThan(far)
  })

  it('prefers the nearer edge when the pane is shorter than two edge bands', () => {
    // pane only 40px tall, pointer 5px from bottom -> should scroll down
    expect(edgeScrollDelta(135, 100, 140, OPTS)).toBeGreaterThan(0)
  })
})

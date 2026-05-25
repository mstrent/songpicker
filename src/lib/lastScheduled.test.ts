import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lastScheduledDisplay } from './lastScheduled'

// Anchor "now" to make relative-time math deterministic.
const NOW = new Date('2026-05-25T12:00:00Z').getTime()

function isoDaysFromNow(days: number): string {
  return new Date(NOW + days * 24 * 60 * 60 * 1000).toISOString()
}

describe('lastScheduledDisplay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null for unparseable ISO', () => {
    expect(lastScheduledDisplay('not-a-date')).toBeNull()
  })

  it('treats past dates as "last played"', () => {
    const out = lastScheduledDisplay(isoDaysFromNow(-3))
    expect(out?.kind).toBe('past')
    expect(out?.label).toBe('last played 3 days ago')
    expect(out?.recent).toBe(true)
  })

  it('marks recent past dates (< 28 days) as recent', () => {
    const out = lastScheduledDisplay(isoDaysFromNow(-14))
    expect(out?.recent).toBe(true)
  })

  it('does not mark long-past dates as recent', () => {
    const out = lastScheduledDisplay(isoDaysFromNow(-90))
    expect(out?.kind).toBe('past')
    expect(out?.recent).toBe(false)
  })

  it('regression: future-scheduled songs show as "scheduled", NOT "last played today"', () => {
    // PCO's last_scheduled_at returns the most recent scheduled date,
    // including future plans. A song queued on next Sunday's plan
    // comes back with a future timestamp. The old relativeTime
    // helper returned "today" for any (now - future) < 1 day case,
    // producing the misleading "last played today" chip.
    const out = lastScheduledDisplay(isoDaysFromNow(6))
    expect(out?.kind).toBe('future')
    expect(out?.label).not.toContain('last played')
    expect(out?.label).toMatch(/^scheduled /)
  })

  it('formats future dates as "scheduled M/D"', () => {
    // 7 days from 2026-05-25 → 2026-06-01
    const out = lastScheduledDisplay(isoDaysFromNow(7))
    expect(out?.label).toBe('scheduled 6/1')
  })

  it('flags near-future dates (< 28 days) as recent', () => {
    const out = lastScheduledDisplay(isoDaysFromNow(7))
    expect(out?.recent).toBe(true)
  })

  it('does not flag far-future dates (>= 28 days) as recent', () => {
    const out = lastScheduledDisplay(isoDaysFromNow(60))
    expect(out?.kind).toBe('future')
    expect(out?.recent).toBe(false)
  })

  it('past tooltip mentions congregation notice when recent', () => {
    const out = lastScheduledDisplay(isoDaysFromNow(-3))
    expect(out?.tooltip).toContain('congregations may notice')
  })

  it('future tooltip mentions upcoming plan', () => {
    const out = lastScheduledDisplay(isoDaysFromNow(7))
    expect(out?.tooltip).toContain('upcoming plan')
  })
})

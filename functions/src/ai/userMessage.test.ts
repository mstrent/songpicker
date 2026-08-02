import { describe, expect, it } from 'vitest'

import { buildUserMessage } from './userMessage'

const base = {
  userMessage: 'something for Sunday',
  theme: 'gratitude',
  systemPrompt: 'unused here',
}

describe('recentlySung placement', () => {
  // Rotation context derives from PAST plans, so it doesn't move when
  // the user commits a song to the plan they're working on. Keeping it
  // in the stable half means it sits behind the 1h cache breakpoint
  // and isn't re-sent at full price on every turn of a session.
  it('rides in the stable half, not the volatile half', () => {
    const built = buildUserMessage({
      ...base,
      recentlySung: 'Recently sung by this congregation:\n  ...',
    })
    expect(built.stable).toContain('Recently sung by this congregation')
    expect(built.volatile).not.toContain('Recently sung')
  })

  it('is omitted entirely when there is nothing to report', () => {
    expect(buildUserMessage({ ...base, recentlySung: '' }).stable).not.toMatch(
      /Recently sung/,
    )
    expect(buildUserMessage(base).stable).not.toMatch(/Recently sung/)
  })

  // The stable half is a cached prefix: an empty or whitespace-only
  // value must not leave a stray blank line, which would change the
  // prefix bytes and cost a cache write for no content.
  it('does not leave a blank line when whitespace-only', () => {
    const built = buildUserMessage({ ...base, recentlySung: '   \n  ' })
    expect(built.stable).toBe(buildUserMessage(base).stable)
  })
})

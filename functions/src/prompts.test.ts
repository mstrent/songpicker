import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ROLE_PROMPT,
  TECHNICAL_REQUIREMENTS,
  composeSystemPrompt,
} from './prompts'

// These pin the *shape* of the selection guidance, not its wording.
// The failure they exist to catch is a silent one: the model kept
// proposing the same small pool of ubiquitous worship songs regardless
// of the plan's theme, which reads as "the AI is a bit boring" rather
// than as a bug. Nothing here fails loudly in production, so the guard
// has to live in the suite.
describe('song-selection guidance', () => {
  // The original role prompt asked for "well-known" songs, which is a
  // direct instruction to sample the highest-frequency region of the
  // model's training data — the single largest contributor to
  // repetitive suggestions.
  it('does not ask for well-known songs', () => {
    expect(DEFAULT_ROLE_PROMPT).not.toMatch(/well[- ]known/i)
    expect(TECHNICAL_REQUIREMENTS).not.toMatch(/well[- ]known/i)
  })

  // The first cut of this guidance said "prefer the less ubiquitous"
  // song, which aimed at the wrong target: it produced deep cuts a
  // congregation has never heard. The goal is rotation across weeks,
  // not novelty — familiarity is not the thing that causes fatigue.
  it('rules out obscure songs rather than favouring them', () => {
    expect(TECHNICAL_REQUIREMENTS).toMatch(/deep cuts/i)
    expect(TECHNICAL_REQUIREMENTS).not.toMatch(/less ubiquitous/i)
  })

  it('frames variety as across weeks rather than away from familiarity', () => {
    expect(TECHNICAL_REQUIREMENTS).toMatch(/across weeks/i)
  })

  it('requires a per-proposal justification', () => {
    expect(TECHNICAL_REQUIREMENTS).toMatch(/"reason"/)
  })

  it('asks for variety within the options offered for a role', () => {
    expect(TECHNICAL_REQUIREMENTS).toMatch(/vary the set/i)
  })

  // The don't-invent guard has to come before the selection guidance:
  // the selection rules widen what the model reaches for, and the
  // guard is what stops that widening from turning into plausible-
  // sounding titles it can't actually place.
  it('states the don-t-invent rule before the selection guidance', () => {
    const dontInvent = TECHNICAL_REQUIREMENTS.indexOf("don't invent songs")
    const selection = TECHNICAL_REQUIREMENTS.indexOf('How to choose songs')
    expect(dontInvent).toBeGreaterThanOrEqual(0)
    expect(selection).toBeGreaterThan(dontInvent)
  })

  // The selection rules have to survive a user or admin replacing the
  // role prompt, so they live in the non-editable technical block.
  it('survives a fully replaced role prompt', () => {
    const composed = composeSystemPrompt('You are a pirate.')
    expect(composed).toMatch(/deep cuts/i)
    expect(composed).toMatch(/vary the set/i)
  })
})

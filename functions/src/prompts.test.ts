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

  it('tells the model to favour less ubiquitous songs', () => {
    expect(TECHNICAL_REQUIREMENTS).toMatch(/ubiquitous/i)
  })

  it('requires a per-proposal justification', () => {
    expect(TECHNICAL_REQUIREMENTS).toMatch(/"reason"/)
  })

  it('asks for variety within the options offered for a role', () => {
    expect(TECHNICAL_REQUIREMENTS).toMatch(/vary the set/i)
  })

  // Ordering is load-bearing: the "reach past the obvious" guidance
  // explicitly defers to the don't-invent rule ("This never overrides
  // the don't-invent rule above"). If the blocks are ever reordered
  // that back-reference becomes a forward-reference to nothing, and
  // the guardrail against hallucinated titles reads as optional.
  it('states the don-t-invent rule before the reach-further guidance', () => {
    const dontInvent = TECHNICAL_REQUIREMENTS.indexOf("don't invent songs")
    const reachFurther = TECHNICAL_REQUIREMENTS.indexOf('Reach past the obvious')
    expect(dontInvent).toBeGreaterThanOrEqual(0)
    expect(reachFurther).toBeGreaterThan(dontInvent)
  })

  // The selection rules have to survive a user or admin replacing the
  // role prompt, so they live in the non-editable technical block.
  it('survives a fully replaced role prompt', () => {
    const composed = composeSystemPrompt('You are a pirate.')
    expect(composed).toMatch(/ubiquitous/i)
    expect(composed).toMatch(/vary the set/i)
  })
})

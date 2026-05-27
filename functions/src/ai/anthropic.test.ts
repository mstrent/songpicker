import { describe, expect, it } from 'vitest'

import { CLASSIFY_SONG_TOOL } from './anthropic'

describe('tool schema regression', () => {
  it('CHORUS_SNIPPET_GUIDANCE is no longer exported', async () => {
    const mod = await import('./anthropic')
    expect(mod).not.toHaveProperty('CHORUS_SNIPPET_GUIDANCE')
  })

  it('classify_song schema does not include chorusSnippet', () => {
    const props = (
      CLASSIFY_SONG_TOOL.input_schema as {
        properties: Record<string, unknown>
      }
    ).properties
    expect(props).not.toHaveProperty('chorusSnippet')
  })
})

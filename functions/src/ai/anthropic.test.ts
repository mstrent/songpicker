import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CLASSIFY_SONG_TOOL, TOOLS } from './anthropic'

// Capture the params handed to messages.stream so we can assert on the
// request shape without touching the network. `nextFinalMessage` lets a
// test stage what the stream resolves to.
const streamCalls: Array<Record<string, unknown>> = []
const OK_MESSAGE = {
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'ok' }],
}
let nextFinalMessage: Record<string, unknown> = OK_MESSAGE

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = {
      stream: (params: Record<string, unknown>) => {
        streamCalls.push(params)
        return Object.assign(
          (async function* () {})(),
          { finalMessage: async () => nextFinalMessage },
        )
      },
      create: async () => ({ content: [] }),
    }
  }
  return { default: FakeAnthropic }
})

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

describe('propose_songs reason field', () => {
  beforeEach(() => {
    streamCalls.length = 0
    nextFinalMessage = OK_MESSAGE
  })

  function proposeSchema() {
    const tool = TOOLS.find((t) => t.name === 'propose_songs')!
    const suggestions = (
      tool.input_schema as {
        properties: { suggestions: { items: Record<string, unknown> } }
      }
    ).properties.suggestions
    return suggestions.items as {
      properties: Record<string, unknown>
      required: string[]
    }
  }

  // The justification is what forces the theme to actually discriminate
  // between songs — without it "fit" is unfalsifiable and nearly any
  // worship song qualifies. Required in the schema so the model treats
  // it as part of proposing, not an optional flourish.
  it('is required by the schema', () => {
    const item = proposeSchema()
    expect(item.properties).toHaveProperty('reason')
    expect(item.required).toContain('reason')
  })

  async function proposeWith(suggestion: Record<string, unknown>) {
    nextFinalMessage = {
      stop_reason: 'end_turn',
      content: [
        {
          type: 'tool_use',
          name: 'propose_songs',
          input: { suggestions: [suggestion] },
        },
      ],
    }
    const result = await suggest()
    const action = result.actions[0]
    if (action.kind !== 'propose') throw new Error('expected a propose action')
    return action.suggestions[0]
  }

  it('is carried through to the proposed suggestion', async () => {
    const s = await proposeWith({
      title: 'Cornerstone',
      reason: 'the "my hope is built" verse echoes the sermon text',
    })
    expect(s.reason).toBe('the "my hope is built" verse echoes the sermon text')
  })

  // Schema-required is a nudge, not an enforcement (no strict mode), so
  // a model that skips the field must still get its song into the pool
  // rather than have the whole suggestion silently dropped.
  it('does not drop a suggestion that omits it', async () => {
    const s = await proposeWith({ title: 'Cornerstone' })
    expect(s.title).toBe('Cornerstone')
    expect(s.reason).toBeUndefined()
  })

  it('treats a blank reason as absent rather than empty', async () => {
    const s = await proposeWith({ title: 'Cornerstone', reason: '   ' })
    expect(s.reason).toBeUndefined()
  })
})

async function suggest() {
  const { AnthropicProvider } = await import('./anthropic')
  return new AnthropicProvider('test-key').suggestSongs({
    userMessage: 'something upbeat',
    theme: 'hope',
    systemPrompt: 'You are a worship planning assistant.',
  })
}

describe('suggestSongs request shape', () => {
  beforeEach(() => {
    streamCalls.length = 0
    nextFinalMessage = OK_MESSAGE
  })

  async function runOnce() {
    await suggest()
    return streamCalls[0]
  }

  it('runs on Sonnet 5 with adaptive thinking', async () => {
    const params = await runOnce()
    expect(params.model).toBe('claude-sonnet-5-5')
    expect(params.thinking).toEqual({ type: 'adaptive' })
  })

  // Sonnet 5 defaults to `high`, and left unset a suggest turn burned
  // ~4,700 thinking tokens and 57 seconds on ten songs — all of it
  // silent, because tool_use only decodes at content_block_stop. The
  // level is tunable; having none at all is the regression.
  it('sets an explicit effort level rather than taking the default', async () => {
    const params = await runOnce()
    const outputConfig = params.output_config as { effort?: string }
    expect(outputConfig?.effort).toBeTruthy()
  })

  // max_tokens is a shared ceiling over thinking + response text. Drop
  // it back toward the pre-Sonnet-5 4000 and a turn that thinks through
  // a multi-slot rearrangement truncates silently — no error, the
  // stream just ends mid-reply. Guard the headroom.
  it('leaves room for thinking above the response text', async () => {
    const params = await runOnce()
    expect(params.max_tokens).toBeGreaterThanOrEqual(16000)
  })

  it('keeps both 1-hour cache breakpoints', async () => {
    const params = await runOnce()
    const system = params.system as Array<{ cache_control?: unknown }>
    const messages = params.messages as Array<{
      content: Array<{ cache_control?: unknown }>
    }>
    expect(system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    // Stable half of the current user turn carries the second one; the
    // volatile half deliberately does not.
    const current = messages[messages.length - 1].content
    expect(current[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(current[1].cache_control).toBeUndefined()
  })
})

describe('safety-classifier refusal', () => {
  beforeEach(() => {
    streamCalls.length = 0
    nextFinalMessage = OK_MESSAGE
  })

  // A refusal is a successful HTTP 200 with no content. Before this was
  // handled it parsed to zero actions and no prose, and the chat log
  // rendered "No changes this turn." — asserting a decision the model
  // never made.
  it('throws instead of reporting an empty turn', async () => {
    nextFinalMessage = {
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
      content: [],
    }
    await expect(suggest()).rejects.toThrow(/safety system declined/i)
  })

  it('names the policy category when the API supplies one', async () => {
    nextFinalMessage = {
      stop_reason: 'refusal',
      stop_details: { category: 'general_harms' },
      content: [],
    }
    await expect(suggest()).rejects.toThrow(/general_harms/)
  })

  it('still throws when stop_details is absent', async () => {
    nextFinalMessage = { stop_reason: 'refusal', content: [] }
    await expect(suggest()).rejects.toThrow(/safety system declined/i)
  })

  // The content-filter retry matches on message text; a refusal must not
  // be mistaken for one, since re-sending the same prompt won't help.
  it('is not retried as a content-filter block', async () => {
    nextFinalMessage = { stop_reason: 'refusal', content: [] }
    await expect(suggest()).rejects.toThrow()
    expect(streamCalls).toHaveLength(1)
  })

  it('returns normally on a non-refusal turn', async () => {
    const result = await suggest()
    expect(result.message).toBe('ok')
  })
})

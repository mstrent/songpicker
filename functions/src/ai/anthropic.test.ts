import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CLASSIFY_SONG_TOOL } from './anthropic'

// Capture the params handed to messages.stream so we can assert on the
// request shape without touching the network.
const streamCalls: Array<Record<string, unknown>> = []

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = {
      stream: (params: Record<string, unknown>) => {
        streamCalls.push(params)
        return Object.assign(
          (async function* () {})(),
          {
            finalMessage: async () => ({
              content: [{ type: 'text', text: 'ok' }],
            }),
          },
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

describe('suggestSongs request shape', () => {
  beforeEach(() => {
    streamCalls.length = 0
  })

  async function runOnce() {
    const { AnthropicProvider } = await import('./anthropic')
    await new AnthropicProvider('test-key').suggestSongs({
      userMessage: 'something upbeat',
      theme: 'hope',
      systemPrompt: 'You are a worship planning assistant.',
    })
    return streamCalls[0]
  }

  it('runs on Sonnet 5 with adaptive thinking', async () => {
    const params = await runOnce()
    expect(params.model).toBe('claude-sonnet-5')
    expect(params.thinking).toEqual({ type: 'adaptive' })
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

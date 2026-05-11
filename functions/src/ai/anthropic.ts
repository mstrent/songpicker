import Anthropic from '@anthropic-ai/sdk'
import { buildUserMessage } from './userMessage'
import type { AiProvider, SongSuggestion, SuggestRequest, SuggestResult } from './types'

const MODEL = 'claude-sonnet-4-6'

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async suggestSongs(req: SuggestRequest): Promise<SuggestResult> {
    const userMessage = buildUserMessage(req)
    const systemPrompt = req.systemPrompt
    const res = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: userMessage }],
    })

    const text = res.content.find((c) => c.type === 'text')?.text ?? '{}'
    const parsed = JSON.parse(extractJson(text)) as { suggestions?: SongSuggestion[] }
    return {
      suggestions: parsed.suggestions ?? [],
      debug: { model: MODEL, systemPrompt, userMessage },
    }
  }
}

// Claude often wraps JSON output in a ```json ... ``` fence even when asked
// not to. Strip the fence; fall back to the largest {...} substring as a
// safety net for any other prefix/suffix chatter.
function extractJson(raw: string): string {
  const text = raw.trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced) return fenced[1].trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) return text.slice(first, last + 1)
  return text
}

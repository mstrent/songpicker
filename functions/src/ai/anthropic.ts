import Anthropic from '@anthropic-ai/sdk'
import type { AiProvider, SongSuggestion, SuggestRequest } from './types'

const SYSTEM_PROMPT = `You suggest contemporary worship songs for a church service.
Given a theme and criteria, return real, well-known worship songs that fit.
Reply ONLY with JSON in this exact shape:
{"suggestions":[{"title":"Song Title","author":"Songwriter Name","reasoning":"why this fits"}]}
Return exactly the requested count. Do not invent songs that don't exist.`

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async suggestSongs(req: SuggestRequest): Promise<SongSuggestion[]> {
    const count = req.count ?? 8
    const exclude = req.exclude?.length
      ? `\n\nDo NOT suggest any of these (already considered): ${req.exclude.join(', ')}`
      : ''
    const userMsg = `Theme: ${req.theme}\nCriteria: ${req.criteria || '(none)'}\nReturn ${count} suggestions.${exclude}`

    const res = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: userMsg }],
    })

    const text = res.content.find((c) => c.type === 'text')?.text ?? '{}'
    const parsed = JSON.parse(text) as { suggestions?: SongSuggestion[] }
    return parsed.suggestions ?? []
  }
}

import OpenAI from 'openai'
import type { AiProvider, SongSuggestion, SuggestRequest } from './types'

const SYSTEM_PROMPT = `You suggest contemporary worship songs for a church service.
Given a theme and criteria, return real, well-known worship songs that fit.
Reply with JSON in this exact shape:
{"suggestions":[{"title":"Song Title","author":"Songwriter Name","reasoning":"why this fits"}]}
Return exactly the requested count. Do not invent songs that don't exist.`

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey })
  }

  async suggestSongs(req: SuggestRequest): Promise<SongSuggestion[]> {
    const count = req.count ?? 8
    const exclude = req.exclude?.length
      ? `\n\nDo NOT suggest any of these (already considered): ${req.exclude.join(', ')}`
      : ''
    const userMsg = `Theme: ${req.theme}\nCriteria: ${req.criteria || '(none)'}\nReturn ${count} suggestions.${exclude}`

    const res = await this.client.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
    })

    const text = res.choices[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(text) as { suggestions?: SongSuggestion[] }
    return parsed.suggestions ?? []
  }
}

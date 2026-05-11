import OpenAI from 'openai'
import { buildUserMessage } from './userMessage'
import type { AiProvider, SongSuggestion, SuggestRequest, SuggestResult } from './types'

const SYSTEM_PROMPT = `You suggest contemporary worship songs for a church service.
Given a theme and criteria, return real, well-known worship songs that fit.
Reply with JSON in this exact shape:
{"suggestions":[{"title":"Song Title","author":"Songwriter Name","reasoning":"why this fits"}]}
Return exactly the requested count. Do not invent songs that don't exist.`

const MODEL = 'gpt-4o'

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey })
  }

  async suggestSongs(req: SuggestRequest): Promise<SuggestResult> {
    const userMessage = buildUserMessage(req)
    const res = await this.client.chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    })

    const text = res.choices[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(text) as { suggestions?: SongSuggestion[] }
    return {
      suggestions: parsed.suggestions ?? [],
      debug: { model: MODEL, systemPrompt: SYSTEM_PROMPT, userMessage },
    }
  }
}

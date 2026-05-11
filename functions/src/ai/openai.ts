import OpenAI from 'openai'
import { buildAssistantSummary, buildUserMessage } from './userMessage'
import type { AiProvider, SongSuggestion, SuggestRequest, SuggestResult } from './types'

const MODEL = 'gpt-4o'

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey })
  }

  async suggestSongs(req: SuggestRequest): Promise<SuggestResult> {
    const userMessage = buildUserMessage(req)
    const systemPrompt = req.systemPrompt
    const history = req.history ?? []
    const res = await this.client.chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: 'user', content: userMessage },
      ],
    })

    const text = res.choices[0]?.message?.content ?? '{}'
    const parsed = JSON.parse(text) as { suggestions?: SongSuggestion[] }
    const suggestions = parsed.suggestions ?? []
    return {
      suggestions,
      debug: { model: MODEL, systemPrompt, userMessage },
      assistantMessage: buildAssistantSummary(suggestions),
    }
  }
}

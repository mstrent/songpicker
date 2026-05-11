import { GoogleGenAI } from '@google/genai'
import { buildAssistantSummary, buildUserMessage } from './userMessage'
import type { AiProvider, SongSuggestion, SuggestRequest, SuggestResult } from './types'

const MODEL = 'gemini-2.5-flash'

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const
  private client: GoogleGenAI

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey })
  }

  async suggestSongs(req: SuggestRequest): Promise<SuggestResult> {
    const userMessage = buildUserMessage(req)
    const systemPrompt = req.systemPrompt
    const history = req.history ?? []
    // Gemini uses 'user' / 'model' role names instead of user/assistant.
    const contents = [
      ...history.map((t) => ({
        role: t.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: t.content }],
      })),
      { role: 'user', parts: [{ text: userMessage }] },
    ]

    const res = await this.client.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
      },
    })

    const text = res.text ?? '{}'
    const parsed = JSON.parse(text) as { suggestions?: SongSuggestion[] }
    const suggestions = parsed.suggestions ?? []
    return {
      suggestions,
      debug: { model: MODEL, systemPrompt, userMessage },
      assistantMessage: buildAssistantSummary(suggestions),
    }
  }
}

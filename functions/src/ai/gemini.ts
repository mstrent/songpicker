import { GoogleGenAI } from '@google/genai'
import { buildUserMessage } from './userMessage'
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
    const res = await this.client.models.generateContent({
      model: MODEL,
      contents: userMessage,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: 'application/json',
      },
    })

    const text = res.text ?? '{}'
    const parsed = JSON.parse(text) as { suggestions?: SongSuggestion[] }
    return {
      suggestions: parsed.suggestions ?? [],
      debug: { model: MODEL, systemPrompt, userMessage },
    }
  }
}
